const WebSocket = require('ws');
const config = require('../../config');
const { getConnection, removeConnection } = require('../../core/websocket/connectionManager');
const { createPlayAudioMessage } = require('../../core/audio/audioProcessor');

// Store active ElevenLabs conversations
const activeConversations = new Map();
let clientMessageHandler = null;

/**
 * Create a new conversation with ElevenLabs agent
 */
async function createConversation(sessionId, treatmentType = config.session.defaultTreatmentType, agentId = config.elevenlabs.agentId, dynamicFields = {}) {
  try {

    const agentWebSocket = new WebSocket(`${config.elevenlabs.websocketUrl}/v1/convai/conversation?agent_id=${agentId}`, {
      headers: {
        'xi-api-key': config.elevenlabs.apiKey
      }
    });

    const conversationSession = {
      sessionId,
      agentWebSocket,
      conversationId: null,
      audioFormat: null,
      isReady: false,
      treatmentType,
      agentId,
      dynamicFields
    };

    // Handle WebSocket events
    setupWebSocketHandlers(agentWebSocket, conversationSession);

    // Store conversation
    activeConversations.set(sessionId, conversationSession);

    // Wait for connection
    await waitForConnection(agentWebSocket);

    return conversationSession;

  } catch (error) {
    console.error('❌ Failed to create ElevenLabs conversation:', error.message);
    throw error;
  }
}

/**
 * Setup WebSocket event handlers for ElevenLabs connection
 */
function setupWebSocketHandlers(agentWebSocket, conversationSession) {
  agentWebSocket.on('open', () => {
    console.log(`✅ ElevenLabs WebSocket connected for session: ${conversationSession.sessionId}`);
    initializeConversation(conversationSession);
  });

  agentWebSocket.on('message', async (data) => {
    try {
      console.log(`📨 Raw ElevenLabs message received: ${data.length} bytes for session: ${conversationSession.sessionId}`);
      await handleElevenLabsMessage(data, conversationSession);
    } catch (error) {
      console.error(`❌ ERROR in WebSocket message handler for session ${conversationSession.sessionId}:`, error.message);
      console.error(`🔍 Stack trace:`, error.stack);
    }
  });

  agentWebSocket.on('ping', (data) => {
    console.log('📡 Received ping from ElevenLabs');
    agentWebSocket.pong(data);
  });

  agentWebSocket.on('pong', (data) => {
    console.log('📡 Received pong from ElevenLabs');
  });

  agentWebSocket.on('close', (code, reason) => {
    console.error(`🔌 CRITICAL: ElevenLabs WebSocket CLOSED for session: ${conversationSession.sessionId}`);
    console.error(`🔍 Close code: ${code} Reason: ${reason.toString()}`);
    console.error(`🔍 Active conversations before cleanup: ${activeConversations.size}`);
    
    // Clean up the conversation
    activeConversations.delete(conversationSession.sessionId);
    console.error(`🔍 Active conversations after cleanup: ${activeConversations.size}`);
    
    // Also close the Knowlarity connection when ElevenLabs closes
    closeKnowlarityConnection(conversationSession.sessionId);
  });

  agentWebSocket.on('error', (error) => {
    console.error(`❌ CRITICAL: ElevenLabs WebSocket ERROR for session ${conversationSession.sessionId}:`, error.message);
    console.error(`🔍 Error code: ${error.code}`);
    console.error(`🔍 Error stack: ${error.stack}`);
    console.error(`🔍 WebSocket state at error: ${agentWebSocket.readyState}`);
    
    // Clean up conversation on error
    activeConversations.delete(conversationSession.sessionId);
    
    // Also close Knowlarity connection on ElevenLabs error
    closeKnowlarityConnection(conversationSession.sessionId);
  });
}

/**
 * Initialize conversation with ElevenLabs agent
 */
function initializeConversation(conversationSession) {
  // Check connection state before sending
  if (conversationSession.agentWebSocket.readyState !== 1) {
    console.error('❌ Cannot initialize - WebSocket not ready');
    return;
  }

  // Use dynamic fields from metadata for proper agent initialization
  const dynamicVariables = {
    user_name: conversationSession.dynamicFields?.user_name || 'Patient',
    language: conversationSession.dynamicFields?.language || 'hindi',
    user_id: conversationSession.sessionId,
    treatmentType: conversationSession.treatmentType || 'piles',
    // Pass all additional dynamic fields from metadata
    ...conversationSession.dynamicFields
  };

  const initializationMessage = {
    type: 'conversation_initiation_client_data',
    dynamic_variables: dynamicVariables,
    // Add conversation config override - this is required for working version
    conversation_config_override: {
      agent: {
        language: conversationSession.dynamicFields?.language || 'hi'  // Use language from metadata
      }
    }
  };
  
  console.log('📤 Initializing conversation with dynamic fields from metadata');
  console.log('🔍 Dynamic variables:', JSON.stringify(dynamicVariables, null, 2));
  
  console.log('📤 Initializing conversation with correct client data structure');
  console.log('🔍 Initialization message:', JSON.stringify(initializationMessage, null, 2));
  
  try {
    conversationSession.agentWebSocket.send(JSON.stringify(initializationMessage));
    console.log('✅ Initialization message sent successfully');
  } catch (error) {
    console.error('❌ Failed to send initialization message:', error.message);
  }
}

/**
 * Handle messages from ElevenLabs
 */
async function handleElevenLabsMessage(data, conversationSession) {
  try {
    console.log(`🔍 PARSING ElevenLabs message for session: ${conversationSession.sessionId}`);
    const message = JSON.parse(data.toString());
    
    // Log ALL ElevenLabs messages to debug conversation flow
    console.log(`📨 ElevenLabs message type: ${message.type} for session: ${conversationSession.sessionId}`);
    console.log(`🔍 Full message:`, JSON.stringify(message, null, 2));

    switch (message.type) {
      case 'conversation_initiation_metadata':
        console.log(`🔄 Processing conversation_initiation_metadata for session: ${conversationSession.sessionId}`);
        await handleConversationReady(message, conversationSession);
        break;

      case 'audio':
        console.log(`🔊 Processing audio message for session: ${conversationSession.sessionId}`);
        handleAgentAudio(message, conversationSession);
        break;

      case 'agent_response':
        console.log(`💬 Processing agent_response for session: ${conversationSession.sessionId}`);
        handleAgentResponse(message, conversationSession);
        break;

      case 'ping':
        console.log(`📡 Processing ping for session: ${conversationSession.sessionId}`);
        // Ping received - no action needed
        break;

      default:
        // Log unhandled message types to debug what we're missing
        console.error(`⚠️ UNHANDLED ElevenLabs message type: ${message.type} for session: ${conversationSession.sessionId}`);
        console.error(`🔍 Unhandled message content:`, JSON.stringify(message, null, 2));
    }

  } catch (error) {
    console.error(`❌ CRITICAL ERROR processing ElevenLabs message for session ${conversationSession.sessionId}:`, error.message);
    console.error(`🔍 Raw message data:`, data.toString());
    console.error(`🔍 Stack trace:`, error.stack);
  }
}

/**
 * Handle conversation ready event
 */
async function handleConversationReady(message, conversationSession) {
  try {
    // Store conversation metadata
    conversationSession.conversationId = message.conversation_initiation_metadata_event?.conversation_id;
    conversationSession.audioFormat = message.conversation_initiation_metadata_event?.agent_output_audio_format;
    conversationSession.isReady = true;
    
    console.log(`✅ ElevenLabs conversation ready for session: ${conversationSession.sessionId}`);
    console.log(`🔊 Ready for real-time audio streaming (no buffering) - like working dev branch`);
    
    // Update connection manager with ready status
    const { updateConnection } = require('../../core/websocket/connectionManager');
    updateConnection(conversationSession.sessionId, {
      agentConversation: conversationSession,
      elevenLabsInitialized: true
    });
    
  } catch (error) {
    console.error(`❌ Error handling conversation ready for session ${conversationSession.sessionId}:`, error.message);
  }
}

/**
 * Handle audio from ElevenLabs agent
 */
function handleAgentAudio(message, conversationSession) {
  try {
    console.log(`🔍 AUDIO HANDLER DEBUG for session: ${conversationSession.sessionId}`);
    console.log(`  - clientMessageHandler exists: ${!!clientMessageHandler}`);
    console.log(`  - audio_base_64 exists: ${!!message.audio_event?.audio_base_64}`);
    console.log(`  - audio_base_64 length: ${message.audio_event?.audio_base_64?.length || 0} chars`);
    
    if (clientMessageHandler) {
      const agentMessage = {
        type: "agent_audio",
        audio: message.audio_event?.audio_base_64
      };
      
      console.log(`📤 Forwarding agent audio to client for session: ${conversationSession.sessionId}`);
      clientMessageHandler(conversationSession.sessionId, agentMessage);
      console.log(`✅ Agent audio forwarded successfully for session: ${conversationSession.sessionId}`);
    } else {
      console.error(`❌ CRITICAL: No clientMessageHandler for session: ${conversationSession.sessionId}`);
    }
  } catch (error) {
    console.error(`❌ CRITICAL ERROR in handleAgentAudio for session ${conversationSession.sessionId}:`, error.message);
    console.error(`🔍 Stack trace:`, error.stack);
  }
}

/**
 * Handle text response from agent
 */
function handleAgentResponse(message, conversationSession) {
  try {
    console.log(`🔍 RESPONSE HANDLER DEBUG for session: ${conversationSession.sessionId}`);
    console.log(`  - clientMessageHandler exists: ${!!clientMessageHandler}`);
    console.log(`  - agent_response exists: ${!!message.agent_response_event?.agent_response}`);
    console.log(`  - agent_response text: "${message.agent_response_event?.agent_response?.substring(0, 100)}..."`);
    
    if (clientMessageHandler) {
      const agentMessage = {
        type: "agent_response",
        text: message.agent_response_event?.agent_response
      };
      
      console.log(`📤 Forwarding agent response to client for session: ${conversationSession.sessionId}`);
      clientMessageHandler(conversationSession.sessionId, agentMessage);
      console.log(`✅ Agent response forwarded successfully for session: ${conversationSession.sessionId}`);
    } else {
      console.error(`❌ CRITICAL: No clientMessageHandler for session: ${conversationSession.sessionId}`);
    }
  } catch (error) {
    console.error(`❌ CRITICAL ERROR in handleAgentResponse for session ${conversationSession.sessionId}:`, error.message);
    console.error(`🔍 Stack trace:`, error.stack);
  }
}

/**
 * Send audio to ElevenLabs agent
 */
async function sendAudioToAgent(sessionId, audioBase64Data) {
  try {
    const conversation = activeConversations.get(sessionId);
    
    console.log(`🔍 AUDIO SEND DEBUG for session ${sessionId}:`);
    console.log(`  - Conversation exists: ${!!conversation}`);
    console.log(`  - Conversation ready: ${conversation?.isReady}`);
    console.log(`  - WebSocket state: ${conversation?.agentWebSocket?.readyState}`);
    console.log(`  - Audio data length: ${audioBase64Data?.length || 0} chars`);
    
    if (!conversation) {
      console.error('❌ CRITICAL: No ElevenLabs conversation found for session:', sessionId);
      return false;
    }

    if (!conversation.isReady) {
      console.error('❌ CRITICAL: ElevenLabs conversation not ready for session:', sessionId);
      return false;
    }

    // Check connection state before sending audio
    if (conversation.agentWebSocket.readyState !== 1) {
      console.error('❌ CRITICAL: ElevenLabs WebSocket not ready, state:', conversation.agentWebSocket.readyState);
      return false;
    }

    if (!audioBase64Data || audioBase64Data.length === 0) {
      console.error('❌ CRITICAL: Empty audio data for session:', sessionId);
      return false;
    }

    const audioMessage = {
      type: "user_audio_chunk",
      audio_data: audioBase64Data
    };

    console.log(`📤 Sending audio message to ElevenLabs for session: ${sessionId}`);
    conversation.agentWebSocket.send(JSON.stringify(audioMessage));
    console.log(`✅ Audio sent successfully to ElevenLabs for session: ${sessionId}`);
    
    return true;

  } catch (error) {
    console.error(`❌ CRITICAL ERROR sending audio to ElevenLabs for session ${sessionId}:`, error.message);
    console.error(`🔍 Stack trace:`, error.stack);
    return false;
  }
}

/**
 * End conversation
 */
function endConversation(sessionId) {
  const conversation = activeConversations.get(sessionId);
  
  if (conversation) {
    console.log(`🔌 Ending ElevenLabs conversation: ${sessionId}`);
    
    if (conversation.agentWebSocket?.readyState === WebSocket.OPEN) {
      conversation.agentWebSocket.close();
    }
    
    activeConversations.delete(sessionId);
    console.log(`🧹 Conversation ended and cleaned up: ${sessionId}`);
  }
}

/**
 * Set client message handler
 */
function setClientMessageHandler(handler) {
  clientMessageHandler = handler;
  console.log('✅ Message forwarding handler registered - bridge established');
}

/**
 * Wait for WebSocket connection
 */
function waitForConnection(webSocket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Connection timeout'));
    }, 10000);

    webSocket.on('open', () => {
      clearTimeout(timeout);
      resolve();
    });

    webSocket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/**
 * Close Knowlarity connection when ElevenLabs closes
 */
function closeKnowlarityConnection(sessionId) {
  console.log(`🔌 Closing Knowlarity connection due to ElevenLabs closure: ${sessionId}`);
  
  const connection = getConnection(sessionId);
  if (connection?.websocket && connection.websocket.readyState === 1) {
    console.log(`📞 Terminating Knowlarity WebSocket for session: ${sessionId}`);
    connection.websocket.close(1000, "ElevenLabs conversation ended");
  }
  
  // Remove from connection manager
  const removed = removeConnection(sessionId);
  if (removed) {
    console.log(`🧹 Knowlarity connection cleaned up for session: ${sessionId}`);
  }
}

/**
 * Get active conversation
 */
function getConversation(sessionId) {
  return activeConversations.get(sessionId);
}

module.exports = {
  createConversation,
  sendAudioToAgent,
  endConversation,
  setClientMessageHandler,
  getConversation,
};