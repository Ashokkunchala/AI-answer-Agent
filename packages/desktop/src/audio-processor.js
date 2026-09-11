// AudioWorklet processor for mic streaming
// Receives raw Float32 PCM, sends back as Int16 to the main thread

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._port.onmessage = (e) => {
      if (e.data === 'flush' && this._buffer.length > 0) {
        this._flush();
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];
    if (channelData.length === 0) return true;

    // Accumulate buffer
    const newBuffer = new Float32Array(this._buffer.length + channelData.length);
    newBuffer.set(this._buffer);
    newBuffer.set(channelData, this._buffer.length);
    this._buffer = newBuffer;

    // Send chunks of 4096 samples (matches ScriptProcessorNode buffer size)
    while (this._buffer.length >= 4096) {
      const chunk = this._buffer.slice(0, 4096);
      this._buffer = this._buffer.slice(4096);
      this._sendChunk(chunk);
    }

    return true;
  }

  _sendChunk(float32Data) {
    // Convert Float32 to Int16 (linear16)
    const int16 = new Int16Array(float32Data.length);
    for (let i = 0; i < float32Data.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Data[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    this._port.postMessage({ type: 'audio', data: int16.buffer }, [int16.buffer]);
  }

  _flush() {
    if (this._buffer.length > 0) {
      this._sendChunk(this._buffer);
      this._buffer = new Float32Array(0);
    }
  }
}

registerProcessor('mic-processor', MicProcessor);
