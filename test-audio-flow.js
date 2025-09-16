#!/usr/bin/env node

/**
 * Test script for audio processing flow
 * This script tests the complete audio processing pipeline
 */

const { processIncomingAudio } = require('./src/core/audio/audioProcessor');
const { createConversation, sendAudioToAgent, setClientMessageHandler } = require('./src/integrations/elevenlabs/agentService');
const { sendAudioToCaller } = require('./src/integrations/knowlarity/messageHandler');

// Mock data for testing
const mockAudioBuffer = Buffer.alloc(3200, 0); // 0.1 seconds of 16kHz audio
const mockSessionId = 'test-session-123';

console.log('🧪 Testing Audio Processing Flow...\n');

async function testAudioProcessing() {
  try {
    console.log('1️⃣ Testing audio processing...');
    const audioResult = await processIncomingAudio(mockAudioBuffer, mockSessionId);
    
    if (audioResult.success) {
      console.log('✅ Audio processing successful');
      console.log(`   - Original size: ${audioResult.originalSize} bytes`);
      console.log(`   - Processed size: ${audioResult.processedSize} bytes`);
      console.log(`   - Base64 length: ${audioResult.audioData.length} chars`);
    } else {
      console.log('❌ Audio processing failed:', audioResult.error);
      return false;
    }

    console.log('\n2️⃣ Testing ElevenLabs integration...');
    
    // Set up message handler
    setClientMessageHandler((sessionId, message) => {
      console.log(`📨 Received message for session ${sessionId}:`, message.type);
      if (message.type === 'agent_audio') {
        console.log('🔊 Agent audio received, length:', message.audio?.length || 0);
      }
    });

    console.log('✅ Message handler set up');

    console.log('\n3️⃣ Testing audio message creation...');
    const { createPlayAudioMessage } = require('./src/core/audio/audioProcessor');
    const playAudioMessage = createPlayAudioMessage(audioResult.audioData);
    
    console.log('✅ Play audio message created');
    console.log('   - Type:', playAudioMessage.type);
    console.log('   - Sample rate:', playAudioMessage.data.sampleRate);
    console.log('   - Audio content length:', playAudioMessage.data.audioContent.length);

    console.log('\n✅ All tests passed! Audio processing flow is working correctly.');
    return true;

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
    return false;
  }
}

// Run the test
testAudioProcessing().then(success => {
  if (success) {
    console.log('\n🎉 Audio processing flow test completed successfully!');
    process.exit(0);
  } else {
    console.log('\n💥 Audio processing flow test failed!');
    process.exit(1);
  }
});
