/**
 * The sound graph. Everything the decoder hears goes into `input`: the
 * microphone when it is on, the generator when it feeds the decoder directly,
 * the test noise. A ScriptProcessorNode hands `input` to the receiver in
 * blocks: an AudioWorklet would want its module from a URL, which the page's
 * policy (nothing loaded from anywhere) does not allow, and these blocks are
 * cheap work for the main thread.
 *
 * Browsers start an AudioContext only after a click, so the engine is made on
 * the first one that needs sound.
 */

const BLOCK = 2048;

export type MicError = 'denied' | 'missing' | 'insecure' | 'failed';

export class AudioEngine {
  readonly ctx: AudioContext;
  /** What the decoder hears. */
  readonly input: GainNode;
  private readonly processor: ScriptProcessorNode;
  private mic: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private noise: AudioBufferSourceNode | null = null;
  private readonly noiseGain: GainNode;

  constructor(onSamples: (samples: Float32Array) => void) {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.input = this.ctx.createGain();
    this.processor = this.ctx.createScriptProcessor(BLOCK, 1, 1);
    this.processor.onaudioprocess = (event) => onSamples(event.inputBuffer.getChannelData(0));
    this.input.connect(this.processor);
    // A processor runs only when connected to the output; through a silent gain, it adds nothing.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.processor.connect(mute).connect(this.ctx.destination);
    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noiseGain.connect(this.input);
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  get micOn(): boolean {
    return this.mic !== null;
  }

  /** After a click: a context created or left suspended by the autoplay policy starts. */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** The microphone into the decoder, untouched: echo cancelling and noise suppression eat tones. */
  async startMic(): Promise<MicError | null> {
    if (this.mic) return null;
    if (!navigator.mediaDevices?.getUserMedia) return 'insecure';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.mic = stream;
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.input);
      await this.resume();
      return null;
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
      return 'failed';
    }
  }

  stopMic(): void {
    this.micSource?.disconnect();
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.mic = null;
    this.micSource = null;
  }

  /** White noise into the decoder only, 0…1. */
  setNoise(level: number): void {
    if (level > 0 && !this.noise) {
      const seconds = 2;
      const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * seconds, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.noise = this.ctx.createBufferSource();
      this.noise.buffer = buffer;
      this.noise.loop = true;
      this.noise.connect(this.noiseGain);
      this.noise.start();
    }
    // Squared: the slider's lower half is where weak signals start to suffer.
    this.noiseGain.gain.setTargetAtTime(level * level * 0.6, this.ctx.currentTime, 0.05);
  }
}
