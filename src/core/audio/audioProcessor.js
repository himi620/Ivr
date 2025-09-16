const config = require('../../config');

/**
 * Process incoming audio from caller
 */
async function processIncomingAudio(audioBuffer, sessionId) {
  try {
    console.log(`🎵 Processing audio for session ${sessionId}: ${audioBuffer.length} bytes`);
    
    // Apply audio amplification like the working dev branch
    let processedAudio = audioBuffer;
    
    // Apply standard amplification (2.5x like in dev branch)
    processedAudio = amplifyAudio(processedAudio);

    // Convert to base64 for ElevenLabs
    const audioBase64 = processedAudio.toString('base64');

    console.log(`✅ Audio processed successfully for session ${sessionId}: ${audioBase64.length} chars base64`);

    return {
      success: true,
      audioData: audioBase64,
      originalSize: audioBuffer.length,
      processedSize: processedAudio.length
    };

  } catch (error) {
    console.error(`❌ Audio processing failed for session ${sessionId}:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Apply noise reduction to audio buffer
 */
function applyNoiseReduction(audioBuffer) {
  try {
    const processedBuffer = Buffer.from(audioBuffer);
    
    // Simple noise gate - remove samples below threshold
    const noiseThreshold = 300; // Adjust based on testing
    
    for (let i = 0; i < processedBuffer.length - 1; i += 2) {
      let sample = processedBuffer.readInt16LE(i);
      
      // Apply noise gate
      if (Math.abs(sample) < noiseThreshold) {
        sample = 0; // Remove low-level noise
      }
      
      processedBuffer.writeInt16LE(sample, i);
    }
    
    return processedBuffer;
  } catch (error) {
    console.error('❌ Noise reduction failed:', error.message);
    return audioBuffer;
  }
}

/**
 * Normalize audio levels
 */
function normalizeAudio(audioBuffer) {
  try {
    const normalizedBuffer = Buffer.from(audioBuffer);
    
    // Find peak amplitude
    let maxAmplitude = 0;
    for (let i = 0; i < normalizedBuffer.length - 1; i += 2) {
      const sample = Math.abs(normalizedBuffer.readInt16LE(i));
      if (sample > maxAmplitude) {
        maxAmplitude = sample;
      }
    }
    
    if (maxAmplitude === 0) return normalizedBuffer;
    
    // Calculate normalization factor (target 70% of max range)
    const targetAmplitude = 32767 * 0.7;
    const normalizationFactor = targetAmplitude / maxAmplitude;
    
    // Apply normalization only if needed
    if (normalizationFactor > 1.1 || normalizationFactor < 0.9) {
      for (let i = 0; i < normalizedBuffer.length - 1; i += 2) {
        let sample = normalizedBuffer.readInt16LE(i);
        sample = Math.round(sample * normalizationFactor);
        sample = Math.max(-32768, Math.min(32767, sample));
        normalizedBuffer.writeInt16LE(sample, i);
      }
    }
    
    return normalizedBuffer;
  } catch (error) {
    console.error('❌ Audio normalization failed:', error.message);
    return audioBuffer;
  }
}

/**
 * Apply standard audio amplification
 */
function amplifyAudio(audioBuffer) {
  try {
    const amplifiedBuffer = Buffer.from(audioBuffer);
    
    // Standard amplification factors based on audio engineering practices
    const amplificationFactor = 1.5; // Conservative 3dB boost
    const softKneeThreshold = 26000; // Soft limiting threshold
    
    for (let i = 0; i < amplifiedBuffer.length - 1; i += 2) {
      let sample = amplifiedBuffer.readInt16LE(i);
      
      // Apply amplification
      sample = sample * amplificationFactor;
      
      // Soft knee compression for loud signals
      if (Math.abs(sample) > softKneeThreshold) {
        const sign = sample >= 0 ? 1 : -1;
        const excess = Math.abs(sample) - softKneeThreshold;
        const compressed = softKneeThreshold + (excess * 0.3); // 3:1 compression ratio
        sample = sign * compressed;
      }
      
      // Hard limiting
      sample = Math.max(-32768, Math.min(32767, Math.round(sample)));
      
      amplifiedBuffer.writeInt16LE(sample, i);
    }
    
    return amplifiedBuffer;
  } catch (error) {
    console.error('❌ Audio amplification failed:', error.message);
    return audioBuffer;
  }
}

/**
 * Log audio details for debugging (only when needed)
 */
function logAudioDetails(audioBuffer) {
  // Only log in debug mode or when explicitly needed
  if (process.env.DEBUG_AUDIO) {
    const sampleCount = audioBuffer.length / 2;
    const duration = sampleCount / config.audio.sampleRate;
    
    console.log(`📊 Audio: ${audioBuffer.length} bytes, ${duration.toFixed(3)}s`);
  }
}

/**
 * Create playAudio message for Knowlarity
 */
function createPlayAudioMessage(base64AudioData) {
  return {
    type: "playAudio",
    data: {
      audioContentType: "raw",
      sampleRate: config.audio.sampleRate,
      audioContent: base64AudioData
    }
  };
}

module.exports = {
  processIncomingAudio,
  applyNoiseReduction,
  normalizeAudio,
  amplifyAudio,
  logAudioDetails,
  createPlayAudioMessage,
};