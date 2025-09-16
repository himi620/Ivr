const {
  addConnection,
  getConnection,
  removeConnection,
} = require("./connectionManager");
const { processInitialMetadata } = require("../metadata/metadataHandler");
const { processIncomingAudio } = require("../audio/audioProcessor");
const {
  sendAudioToCaller,
  handleControlMessage,
} = require("../../integrations/knowlarity/messageHandler");
const {
  createConversation,
  sendAudioToAgent,
  endConversation,
  setClientMessageHandler,
} = require("../../integrations/elevenlabs/agentService");
const config = require("../../config");

/**
 * Handle Knowlarity stream connection
 */
async function handleKnowlarityStream(websocket, urlPath) {
  const sessionId = urlPath.split("/")[2];

  // Validate session ID
  if (!sessionId || sessionId.trim() === "") {
    console.error(`❌ Invalid session ID extracted from URL: ${urlPath}`);
    websocket.close(1008, "Invalid session ID");
    return;
  }

  console.log(`📞 New Knowlarity connection: ${sessionId}`);

  // Use same pattern as working dev branch - simple synchronous flag
  let isFirstMessage = true;

  websocket.on("message", async (incomingMessage) => {
    try {
      console.log(`📥 Message received for session ${sessionId}: ${incomingMessage instanceof Buffer ? `Buffer(${incomingMessage.length})` : `Text(${incomingMessage.length})`}`);
      
      // IMPROVEMENT: Add message counter for better tracking
      // let messageCount = 0;
      // messageCount++;
      // console.log(`📊 Message #${messageCount} for session: ${sessionId}`);
      
      // Handle first message - could be metadata or audio (like working dev branch)
      if (isFirstMessage) {
        console.log(`🎆 Processing first message for session: ${sessionId}`);
        // Set flag IMMEDIATELY and SYNCHRONOUSLY to prevent race condition
        isFirstMessage = false;
        
        // IMPROVEMENT: Add race condition protection with atomic flag
        // const wasFirstMessage = isFirstMessage;
        // isFirstMessage = false;
        // if (!wasFirstMessage) {
        //   console.log(`⚠️ Race condition detected - message already processed for session: ${sessionId}`);
        //   return;
        // }
        
        // Check if first message is JSON metadata or binary audio
        if (await tryProcessAsMetadata(incomingMessage, sessionId)) {
          console.log(`✅ Metadata processed successfully for session: ${sessionId}`);
          return;
        } else {
          console.log(`📤 First message was audio, not metadata for session: ${sessionId}`);
        }
      }

      // IMPROVEMENT: Enhanced message type detection and routing
      // if (incomingMessage instanceof Buffer) {
      //   // Try to parse as JSON first (for client audio messages)
      //   try {
      //     const messageStr = incomingMessage.toString();
      //     const parsedMessage = JSON.parse(messageStr);
      //     
      //     if (parsedMessage.type === "audio-chunk" && parsedMessage.audio) {
      //       console.log(`🎵 Processing JSON audio chunk for session: ${sessionId}`);
      //       // Convert base64 audio to binary
      //       const audioBuffer = Buffer.from(parsedMessage.audio, "base64");
      //       await handleIncomingAudio(audioBuffer, sessionId);
      //     } else if (parsedMessage.type === "control") {
      //       console.log(`🎛️ Processing control message for session: ${sessionId}`);
      //       await handleControlMessage(parsedMessage, sessionId);
      //     } else {
      //       console.log(`📝 Processing JSON message for session: ${sessionId}`);
      //       await handleGenericMessage(parsedMessage, sessionId);
      //     }
      //   } catch (parseError) {
      //     // Not JSON, treat as binary audio
      //     console.log(`🎵 Processing binary audio data for session: ${sessionId}`);
      //     await handleIncomingAudio(incomingMessage, sessionId);
      //   }
      // } else {
      //   // Text message - could be control or metadata
      //   console.log(`📝 Processing text message for session: ${sessionId}`);
      //   try {
      //     const parsedMessage = JSON.parse(incomingMessage);
      //     await handleControlMessage(parsedMessage, sessionId);
      //   } catch (parseError) {
      //     console.log(`📄 Processing plain text message for session: ${sessionId}`);
      //     await handleTextMessage(incomingMessage, sessionId);
      //   }
      // }

      // Route audio and control messages
      console.log(`🔀 Routing message for session: ${sessionId}`);
      await routeIncomingMessage(incomingMessage, sessionId);
    } catch (error) {
      console.error(
        `❌ Error processing message for session ${sessionId}:`,
        error.message
      );
    }
  });

  // Setup connection lifecycle handlers
  websocket.on("close", () => {
    console.log(`📞 Call stream closed for session: ${sessionId}`);
    cleanupSession(sessionId);
  });

  websocket.on("error", (error) => {
    console.error(
      `❌ WebSocket error for session ${sessionId}:`,
      error.message
    );
    cleanupSession(sessionId);
  });

  // Store connection after message handler is set up
  addConnection(sessionId, {
    websocket,
    clientType: "knowlarity",
    agentConversation: null,
    elevenLabsInitialized: false,
  });

  console.log(`🔊 Ready for real-time audio streaming when ElevenLabs initializes - no buffering`);
}

/**
 * Setup global audio streaming handler (called once during startup)
 */
function setupGlobalAudioStreaming() {
  setClientMessageHandler((currentSessionId, agentMessage) => {
    const connection = getConnection(currentSessionId);

    if (connection?.websocket?.readyState === 1) {
      // Handle agent audio
      if (agentMessage.type === "agent_audio" && agentMessage.audio) {
        console.log("🔊 Streaming agent audio to caller");
        sendAudioToCaller(currentSessionId, agentMessage.audio);
      }

      // Handle agent response text
      if (agentMessage.type === "agent_response" && agentMessage.text) {
        console.log(
          `💬 Agent response: ${agentMessage.text.substring(0, 100)}...`
        );
      }

      // Handle audio end
      if (agentMessage.type === "agent_audio_end") {
        console.log("✅ Agent finished speaking");
      }
    } else {
      console.log(
        `⚠️ Cannot send to caller - WebSocket connection lost for session: ${currentSessionId}`
      );
    }
  });
}

// Setup the global handler once when module loads
setupGlobalAudioStreaming();


/**
 * Initialize ElevenLabs agent after metadata is processed
 */
async function initializeAgentAfterMetadata(sessionId) {
  const connection = getConnection(sessionId);
  if (!connection || connection.agentConversation) {
    return; // Already initialized or no connection
  }

  console.log(`🤖 Initializing ElevenLabs conversation for session: ${sessionId}`);

  // Get dynamic fields from connection metadata
  const dynamicFields = connection?.knowlarityMetadata?.dynamicFields || {};
  console.log(`🔄 Using dynamic fields for ElevenLabs:`, JSON.stringify(dynamicFields, null, 2));

  // Use dynamic agentId if provided, otherwise use default
  const agentId = dynamicFields.agentId || config.elevenlabs.agentId;
  const treatmentType = dynamicFields.treatmentType || config.session.defaultTreatmentType;
  const language = dynamicFields.language || config.session.defaultLanguage;

  console.log(`🤖 Using agentId: ${agentId}`);
  console.log(`🎯 Using treatmentType: ${treatmentType}`);
  console.log(`🌐 Using language: ${language}`);

  try {
    const agentConversation = await createConversation(
      sessionId,
      treatmentType,
      agentId,
      dynamicFields
    );

    // Update connection with agent conversation
    connection.agentConversation = agentConversation;
    console.log(`💾 Agent conversation stored for session: ${sessionId}`);

    // Set up callback to process buffered audio when conversation becomes ready
    console.log(`⏳ ElevenLabs connected but waiting for conversation ready signal...`);
    
    // The buffered audio will be processed when handleConversationReady is called
    // This happens when ElevenLabs sends the conversation_initiation_metadata event

    // Notify client that agent is ready
    if (connection?.websocket?.readyState === 1) {
      connection.websocket.send(
        JSON.stringify({
          type: "agent_ready",
          message: "ElevenLabs agent is ready for conversation",
        })
      );
      console.log("📤 Sent agent_ready notification to client");
    }
  } catch (error) {
    console.error(`❌ Failed to initialize ElevenLabs: ${error.message}`);
  }
}

/**
 * Try to process message as metadata, return true if successful
 */
async function tryProcessAsMetadata(incomingMessage, sessionId) {
  try {
    const messageStr = incomingMessage.toString();

    // Quick check - if it contains common metadata fields, try as JSON
    if (messageStr.includes("metadata") || messageStr.includes("callid")) {
      const metadataResult = await processInitialMetadata(incomingMessage, sessionId);
      
      if (metadataResult.success) {
        // Initialize ElevenLabs AFTER metadata is processed
        await initializeAgentAfterMetadata(sessionId);
      }
      
      return true;
    }

    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Route incoming messages (audio or control)
 */
async function routeIncomingMessage(incomingMessage, sessionId) {
  if (incomingMessage instanceof Buffer) {
    // Try to parse as JSON first (for control messages)
    try {
      const messageStr = incomingMessage.toString();
      const parsedMessage = JSON.parse(messageStr);

      if (parsedMessage.type === "audio-chunk" && parsedMessage.audio) {
        // Handle JSON audio chunk
        const audioBuffer = Buffer.from(parsedMessage.audio, "base64");
        await handleIncomingAudio(audioBuffer, sessionId);
      } else {
        // Handle control message
        handleControlMessage(messageStr, sessionId);
      }
    } catch (parseError) {
      // Not JSON, treat as binary audio
      await handleIncomingAudio(incomingMessage, sessionId);
    }
  } else {
    // Handle text control messages
    handleControlMessage(incomingMessage.toString(), sessionId);
  }
}

/**
 * Handle incoming audio from caller
 */
async function handleIncomingAudio(audioBuffer, sessionId) {
  console.log(`🎵 Received audio from caller, size: ${audioBuffer.length} bytes`);

  // IMPROVEMENT: Add audio quality validation
  // if (audioBuffer.length === 0) {
  //   console.warn(`⚠️ Empty audio buffer received for session: ${sessionId}`);
  //   return;
  // }
  
  // IMPROVEMENT: Add audio size validation
  // const MAX_AUDIO_SIZE = 1024 * 1024; // 1MB limit
  // if (audioBuffer.length > MAX_AUDIO_SIZE) {
  //   console.error(`❌ Audio buffer too large for session ${sessionId}: ${audioBuffer.length} bytes`);
  //   return;
  // }

  // Process audio
  const audioResult = await processIncomingAudio(audioBuffer, sessionId);

  if (!audioResult.success) {
    console.error(
      `❌ Audio processing failed for session ${sessionId}:`,
      audioResult.error
    );
    
    // IMPROVEMENT: Add audio processing error recovery
    // try {
    //   console.log(`🔄 Attempting audio processing recovery for session: ${sessionId}`);
    //   // Try alternative audio processing method
    //   const fallbackResult = await processIncomingAudioFallback(audioBuffer, sessionId);
    //   if (fallbackResult.success) {
    //     console.log(`✅ Audio processing recovered for session: ${sessionId}`);
    //     audioResult = fallbackResult;
    //   } else {
    //     console.error(`❌ Audio processing recovery failed for session: ${sessionId}`);
    //     return;
    //   }
    // } catch (recoveryError) {
    //   console.error(`💥 Audio processing recovery error for session ${sessionId}:`, recoveryError.message);
    //   return;
    // }
    
    return;
  }

  console.log(`📤 Base64 length: ${audioResult.audioData.length} characters`);

  // IMPROVEMENT: Add audio buffering for better reliability
  // const connection = getConnection(sessionId);
  // if (!connection?.agentConversation?.isReady) {
  //   // Buffer audio instead of dropping
  //   if (!connection.audioBuffer) {
  //     connection.audioBuffer = [];
  //   }
  //   connection.audioBuffer.push(audioResult.audioData);
  //   console.log(`📦 Buffered audio for session: ${sessionId} (buffer size: ${connection.audioBuffer.length})`);
  //   
  //   // Limit buffer size to prevent memory issues
  //   const MAX_BUFFER_SIZE = 10;
  //   if (connection.audioBuffer.length > MAX_BUFFER_SIZE) {
  //     connection.audioBuffer.shift(); // Remove oldest audio
  //     console.log(`📦 Buffer size limited for session: ${sessionId}`);
  //   }
  //   return;
  // }

  // Send to ElevenLabs agent ONLY if ready - NO BUFFERING (like working dev branch)
  const connection = getConnection(sessionId);
  if (!connection) {
    console.error(`❌ No connection found for session: ${sessionId}`);
    return;
  }

  if (connection?.agentConversation?.isReady) {
    console.log(`🔊 Sending audio to ElevenLabs agent for session: ${sessionId}`);
    const sendResult = await sendAudioToAgent(sessionId, audioResult.audioData);
    if (sendResult) {
      console.log(`✅ Audio sent successfully to ElevenLabs for session: ${sessionId}`);
    } else {
      console.error(`❌ Failed to send audio to ElevenLabs for session: ${sessionId}`);
    }
  } else {
    // Drop audio until ElevenLabs is ready - NO BUFFERING to match dev branch behavior
    const readyStatus = connection?.agentConversation ? 'connected but not ready' : 'not connected';
    console.log(`⚠️ Audio dropped for session: ${sessionId} - ElevenLabs ${readyStatus}`);
    
    // Debug agent status
    console.log(`🔍 Agent status for session ${sessionId}:`, {
      hasConnection: !!connection,
      hasAgentConversation: !!connection?.agentConversation,
      isReady: connection?.agentConversation?.isReady,
      elevenLabsInitialized: connection?.elevenLabsInitialized
    });
  }
}

/**
 * Clean up session resources
 */
function cleanupSession(sessionId) {
  console.log(`🧹 Cleaning up session: ${sessionId}`);

  const connection = getConnection(sessionId);
  const hadConnection = removeConnection(sessionId);

  console.log(
    `💾 Connection removed: ${hadConnection ? "Yes" : "Already gone"}`
  );

  // End ElevenLabs conversation
  if (connection?.agentConversation) {
    console.log("🤖 Ending ElevenLabs conversation...");
    endConversation(sessionId);
    
    // console.log(`✅ ElevenLabs conversation ended for session: ${sessionId}`);
  } else {
    console.log("⚠️ No agent conversation to clean up");
  }

  console.log(`✅ Cleanup completed for session: ${sessionId}`);
}

module.exports = {
  handleKnowlarityStream,
  cleanupSession,
};
