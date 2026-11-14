/**
 * The sound graph. Everything the decoder hears goes into `input`: the
 * selected audio input when it is on, the generator when it feeds the decoder directly,
 * the test noise. A ScriptProcessorNode hands `input` to the receiver in
 * blocks: an AudioWorklet would want its module from a URL, which the page's
 * policy (nothing loaded from anywhere) does not allow, and these blocks are
 * cheap work for the main thread.
 *
 * Browsers start an AudioContext only after a click, so the engine is made on
 * the first one that needs sound.
 */

const BLOCK = 2048;

export type AudioInput = { kind: 'microphone'; deviceId?: string } | { kind: 'loopback' };
export type InputError = 'denied' | 'missing' | 'insecure' | 'unsupported' | 'no-audio' | 'failed';

export class AudioEngine {
  readonly ctx: AudioContext;
  /** What the decoder hears. */
  readonly input: GainNode;
  private readonly processor: ScriptProcessorNode;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private request = 0;
  private noise: AudioBufferSourceNode | null = null;
  private readonly noiseGain: GainNode;

  constructor(onSamples: (samples: Float32Array) => void, private readonly onInputEnded: () => void = () => {}) {
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

  get inputOn(): boolean {
    return this.stream !== null;
  }

  /** After a click: a context created or left suspended by the autoplay policy starts. */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** Call directly from a click: getDisplayMedia needs transient user activation. */
  async startInput(input: AudioInput): Promise<InputError | null> {
    this.stopInput();
    const request = this.request;
    const media = navigator.mediaDevices;
    if (!media) return 'insecure';
    if (input.kind === 'loopback' && !media.getDisplayMedia) return 'unsupported';
    if (input.kind === 'microphone' && !media.getUserMedia) return 'insecure';
    let stream: MediaStream | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    try {
      // Resume during the click as well, before a permission picker can consume
      // activation. Handle rejection immediately while waiting for permission.
      const resumed = this.resume().then(() => true, () => false);
      // Tone processing must stay off: echo cancelling and noise suppression eat Morse.
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      stream = await (input.kind === 'loopback'
        ? media.getDisplayMedia({ video: true, audio, systemAudio: 'include' } as DisplayMediaStreamOptions)
        : media.getUserMedia({ audio: { ...audio, ...(input.deviceId ? { deviceId: { exact: input.deviceId } } : {}) }, video: false }));
      if (request !== this.request) return null;
      if (!stream.getAudioTracks().length) return 'no-audio';
      // Only audio enters the graph. Keep the required display track alive so the
      // browser's Stop sharing control remains valid; no video is read or rendered.
      source = this.ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      source.connect(this.input);
      if (!await resumed) return 'failed';
      if (request !== this.request) return null;
      if (stream.getAudioTracks().every((track) => track.readyState === 'ended')) return 'missing';
      this.stream = stream;
      this.source = source;
      const captured = stream;
      for (const track of stream.getTracks()) track.addEventListener('ended', () => {
        if (this.stream !== captured) return;
        this.stopInput();
        this.onInputEnded();
      });
      return null;
    } catch (error) {
      if (request !== this.request) return null;
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
      return 'failed';
    } finally {
      // Failed, cancelled or superseded requests must never retain capture access.
      if (stream && this.stream !== stream) {
        source?.disconnect();
        for (const track of stream.getTracks()) track.stop();
      }
    }
  }

  stopInput(): void {
    this.request++;
    this.source?.disconnect();
    const stream = this.stream;
    this.stream = null;
    this.source = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
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
