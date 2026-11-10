/**
 * Everything the page does with incoming sound, without the page: the samples
 * go in, spectrum frames for the waterfall and the decoders' text come out.
 * The tests feed it synthesized signals the same way the page feeds it the
 * microphone.
 */
import { Channel, type ChannelOptions } from './decoder';
import { Spectrum } from './fft';

export interface ReceiverOptions extends ChannelOptions {
  sampleRate: number;
  /** Samples per spectrum: 4096 at 48 kHz is 11.7 Hz a bin. */
  fftSize?: number;
  /** Decoders, each off (null) or tuned. */
  slots?: number;
}

export class Receiver {
  readonly sampleRate: number;
  readonly fftSize: number;
  /** Hertz per spectrum bin. */
  readonly binHz: number;
  /** A new spectrum every `hop` samples: four frames per window. */
  readonly hop: number;
  readonly channels: (Channel | null)[];
  /** The spectrum averaged over the last half second or so, in dB per bin. */
  readonly average: Float32Array;
  /** Called with each new spectrum; the array is reused, so copy what you keep. */
  onFrame: ((levels: Float32Array) => void) | null = null;
  private options: ChannelOptions;
  private readonly spectrum: Spectrum;
  private readonly ring: Float32Array;
  private readonly frame: Float32Array;
  private written = 0;
  private sinceFrame = 0;
  private averaged = false;

  constructor({ sampleRate, fftSize = 4096, slots = 2, ...options }: ReceiverOptions) {
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.binHz = sampleRate / fftSize;
    this.hop = fftSize / 4;
    this.options = options;
    this.channels = Array.from({ length: slots }, () => null);
    this.spectrum = new Spectrum(fftSize);
    this.ring = new Float32Array(fftSize);
    this.frame = new Float32Array(fftSize / 2);
    this.average = new Float32Array(fftSize / 2).fill(-120);
  }

  push(samples: Float32Array): void {
    for (const channel of this.channels) channel?.push(samples);
    for (let n = 0; n < samples.length; n++) {
      this.ring[this.written] = samples[n] as number;
      this.written = (this.written + 1) % this.fftSize;
      if (++this.sinceFrame >= this.hop) {
        this.sinceFrame = 0;
        this.spectrum.levels(this.ring, this.written, this.frame);
        this.updateAverage();
        this.onFrame?.(this.frame);
      }
    }
  }

  private updateAverage(): void {
    // In power, not dB: a keyed tone is on half the time and should look it.
    const keep = this.averaged ? 0.92 : 0;
    for (let i = 0; i < this.frame.length; i++) {
      const power = keep * 10 ** ((this.average[i] as number) / 10) + (1 - keep) * 10 ** ((this.frame[i] as number) / 10);
      this.average[i] = 10 * Math.log10(power + 1e-24);
    }
    this.averaged = true;
  }

  /**
   * The strongest signal within `radius` Hz of `frequency`, to the fraction of
   * a bin (a parabola through the peak and its neighbours); `frequency` itself
   * when nothing there stands 6 dB above its surroundings.
   */
  snap(frequency: number, radius: number): number {
    const { average, binHz } = this;
    const from = Math.max(1, Math.floor((frequency - radius) / binHz));
    const to = Math.min(average.length - 2, Math.ceil((frequency + radius) / binHz));
    let best = -1;
    for (let i = from; i <= to; i++) if (best < 0 || (average[i] as number) > (average[best] as number)) best = i;
    if (best < 0) return frequency;
    const around = [];
    for (let i = Math.max(0, best - 40); i <= Math.min(average.length - 1, best + 40); i++) around.push(average[i] as number);
    around.sort((a, b) => a - b);
    const floor = around[Math.floor(around.length / 2)] as number;
    if ((average[best] as number) - floor < 6) return frequency;
    const a = average[best - 1] as number;
    const b = average[best] as number;
    const c = average[best + 1] as number;
    const offset = a - 2 * b + c === 0 ? 0 : (0.5 * (a - c)) / (a - 2 * b + c);
    return (best + Math.max(-0.5, Math.min(0.5, offset))) * binHz;
  }

  /**
   * Tunes decoder `slot` to `frequency`: a new decoder, or the same one moved,
   * its text kept. Within its own passband it is the same signal, only more
   * precisely: the decoder keeps what it has learned of it.
   */
  tune(slot: number, frequency: number): Channel {
    const existing = this.channels[slot];
    if (existing) {
      if (Math.abs(frequency - existing.frequency) <= existing.bandwidthHz / 2) existing.nudge(frequency);
      else existing.retune(frequency);
      return existing;
    }
    const channel = new Channel(this.sampleRate, frequency, this.options);
    this.channels[slot] = channel;
    return channel;
  }

  off(slot: number): void {
    this.channels[slot] = null;
  }

  configure(options: Partial<ChannelOptions>): void {
    this.options = { ...this.options, ...options };
    for (const channel of this.channels) {
      if (options.bandwidth !== undefined) channel?.setBandwidth(options.bandwidth);
      if (options.squelch !== undefined) channel?.setSquelch(options.squelch);
    }
  }
}
