/**
 * One decoder: a tone at a chosen frequency, from samples to Morse codes.
 *
 *   samples → Demodulator → level every TICK_MS → Detector → key down / up
 *           → TimingDecoder → codes (".-") and word spaces
 *
 * The demodulator mixes the tone down to zero and low-passes it, so only a
 * narrow band around the frequency passes: a second signal a few hundred hertz
 * away does not reach this decoder at all. The detector decides key down or up
 * against levels it learns as it goes — the noise floor and the signal's peak —
 * so it needs no gain setting. The timing decoder learns the speed from the
 * lengths it hears: dots and dashes form two clusters, three times apart.
 */
import { decodeSymbol, type MorseLanguage } from './morse';

/** Levels per second: one every 5 ms, a fifth of a dot even at 48 words a minute. */
export const TICK_RATE = 200;

/** The narrowest and widest dot the decoder believes in: 60 and 4 words a minute. */
const MIN_DOT_MS = 20;
const MAX_DOT_MS = 300;

/**
 * A low-pass biquad (RBJ's cookbook), direct form II transposed, run on I and Q
 * at once.
 */
class LowPass {
  private b0 = 0;
  private b1 = 0;
  private a1 = 0;
  private a2 = 0;
  private i1 = 0;
  private i2 = 0;
  private q1 = 0;
  private q2 = 0;

  set(cutoff: number, sampleRate: number, quality: number): void {
    const w = (2 * Math.PI * cutoff) / sampleRate;
    const alpha = Math.sin(w) / (2 * quality);
    const a0 = 1 + alpha;
    this.b0 = (1 - Math.cos(w)) / 2 / a0;
    this.b1 = (1 - Math.cos(w)) / a0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  /** Filters (i, q) in place in `io`. */
  run(io: Float64Array): void {
    const { b0, b1, a1, a2 } = this;
    const i = io[0] as number;
    const q = io[1] as number;
    const yi = b0 * i + this.i1;
    this.i1 = b1 * i - a1 * yi + this.i2;
    this.i2 = b0 * i - a2 * yi;
    const yq = b0 * q + this.q1;
    this.q1 = b1 * q - a1 * yq + this.q2;
    this.q2 = b0 * q - a2 * yq;
    io[0] = yi;
    io[1] = yq;
  }
}

/**
 * The mixer and a fourth-order Butterworth low-pass on I and Q: a passband of
 * `bandwidth` hertz (both sides, cutoff at half of it), and a signal 300 Hz
 * away from a 100 Hz passband some 60 dB down.
 */
export class Demodulator {
  private readonly sampleRate: number;
  private phase = 0;
  private step: number;
  private readonly stages = [new LowPass(), new LowPass()];
  private readonly io = new Float64Array(2);
  private counter = 0;
  /** Samples per level, rounded: the tick lasts tickMs, exactly. */
  readonly tickSamples: number;
  readonly tickMs: number;

  constructor(sampleRate: number, frequency: number, bandwidth: number) {
    this.sampleRate = sampleRate;
    this.step = (2 * Math.PI * frequency) / sampleRate;
    this.tickSamples = Math.max(1, Math.round(sampleRate / TICK_RATE));
    this.tickMs = (this.tickSamples * 1000) / sampleRate;
    this.setBandwidth(bandwidth);
  }

  /** Moves the mixer, keeping the filters' state: a small correction, not a new signal. */
  setFrequency(frequency: number): void {
    this.step = (2 * Math.PI * frequency) / this.sampleRate;
  }

  setBandwidth(bandwidth: number): void {
    // The two sections of a fourth-order Butterworth: Q = 1 / (2 cos(π/8)) and 1 / (2 cos(3π/8)).
    this.stages[0]?.set(bandwidth / 2, this.sampleRate, 0.5412);
    this.stages[1]?.set(bandwidth / 2, this.sampleRate, 1.3066);
  }

  /** Calls `onLevel` with the tone's amplitude every tickSamples samples. */
  process(samples: Float32Array, onLevel: (amplitude: number) => void): void {
    const { io, step, stages } = this;
    const [first, second] = stages as [LowPass, LowPass];
    let { phase, counter } = this;
    for (let n = 0; n < samples.length; n++) {
      const x = samples[n] as number;
      io[0] = x * Math.cos(phase);
      io[1] = -x * Math.sin(phase);
      phase += step;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      first.run(io);
      second.run(io);
      if (++counter >= this.tickSamples) {
        counter = 0;
        // Mixing halves the tone; doubled back, a sine of amplitude A reads A.
        onLevel(2 * Math.hypot(io[0] as number, io[1] as number));
      }
    }
    this.phase = phase;
    this.counter = counter;
  }
}

/** Tunables of the detector; exported for the tests that measure them. */
export const DETECTOR = {
  /** Seconds of levels the noise is measured over: two dashes even at 5 words a minute. */
  window: 2,
  /** Ticks while the filter settles from silence: nothing to learn from yet. */
  settleTicks: 10,
  /** The peak follows the lowest of this many recent levels, so a spike of noise is not a signal. */
  peakHold: 4,
  /** dB per second the peak sinks, for fading. */
  peakDecay: 3,
  /**
   * Ticks the decision lags behind the levels: half a second. The noise and the peak
   * are measured on the newest levels, so a decoder tuned in the middle of a
   * dash has already seen the gap after it when it decides about that dash.
   */
  lookahead: 100,
};

/**
 * The 10th percentile of noise alone sits 8 dB under its median: the noise is
 * reported as the median, so the squelch and the signal-to-noise ratio read in
 * the usual way.
 */
const PERCENTILE = 0.1;
const PERCENTILE_TO_MEDIAN = 8;

/**
 * Key down or up from levels. In dB, it follows two things:
 *
 * - the noise: the 10th percentile of the last two seconds of levels. The key
 *   is up most of the time even while someone is sending, so this lands in
 *   the gaps — also when the signal is there from the first moment, as when
 *   the decoder is tuned to a station already on the air;
 * - the signal: a peak that rises with the level (the lowest of the last few,
 *   so a lone spike of noise does not count) and sinks slowly, for fading.
 *
 * The key is down above the midpoint of the two in amplitude, where a filtered
 * dot rises and falls at the same moments, so dots keep their length. Below
 * `squelch` dB of peak over noise there is no signal, only noise. A change must
 * last `minRunMs` to count, and is then dated back to where it began.
 */
export class Detector {
  noise = Number.NaN;
  peak = Number.NaN;
  level = -120;
  down = false;
  /** Whether there is a signal, by the squelch. */
  open = false;
  squelch: number;
  minRunMs = 10;
  private readonly tickMs: number;
  private readonly levels: Float32Array;
  private readonly sorted: Float32Array;
  private filled = 0;
  private written = 0;
  private recent: number[] = [];
  private readonly delayed: number[] = [];
  private pending = 0;
  private ticks = 0;

  constructor(tickMs: number, squelch: number) {
    this.tickMs = tickMs;
    this.squelch = squelch;
    this.levels = new Float32Array(Math.round((DETECTOR.window * 1000) / tickMs));
    this.sorted = new Float32Array(this.levels.length);
  }

  get snr(): number {
    return Number.isNaN(this.peak) || Number.isNaN(this.noise) ? 0 : Math.max(0, this.peak - this.noise);
  }

  /** Starts over, as on a new frequency. */
  reset(): void {
    this.noise = Number.NaN;
    this.peak = Number.NaN;
    this.down = false;
    this.open = false;
    this.filled = 0;
    this.written = 0;
    this.recent = [];
    this.delayed.length = 0;
    this.pending = 0;
    this.ticks = 0;
  }

  private measureNoise(level: number): void {
    this.levels[this.written] = level;
    this.written = (this.written + 1) % this.levels.length;
    this.filled = Math.min(this.levels.length, this.filled + 1);
    // Sorting two seconds of levels is cheap, but not every tick: the noise moves slowly.
    if (this.filled > 8 && this.ticks % 4 !== 0) return;
    const window = this.sorted.subarray(0, this.filled);
    window.set(this.levels.subarray(0, this.filled));
    window.sort();
    this.noise = (window[Math.floor(this.filled * PERCENTILE)] as number) + PERCENTILE_TO_MEDIAN;
  }

  /**
   * Takes one level. Decides about the one DETECTOR.lookahead ticks older;
   * returns how many ticks before that one the key changed, if it did now (the
   * change began that long ago), or -1.
   */
  push(input: number): number {
    const level = 20 * Math.log10(input + 1e-9);
    this.level = level;
    this.ticks += 1;
    this.delayed.push(input);
    // While the filter rings up from silence its levels say nothing of the noise;
    // they are still decided about, later — a signal may have been there from the start.
    if (this.ticks > DETECTOR.settleTicks) {
      this.measureNoise(level);
      this.recent.push(level);
      if (this.recent.length > DETECTOR.peakHold) this.recent.shift();
      const sustained = Math.min(...this.recent);
      this.peak = Number.isNaN(this.peak) ? sustained : Math.max(sustained, this.peak - (DETECTOR.peakDecay * this.tickMs) / 1000);
    }
    if (this.delayed.length <= DETECTOR.lookahead) return -1;
    const amplitude = this.delayed.shift() as number;

    const noiseAmp = 10 ** (this.noise / 20);
    const peakAmp = 10 ** (this.peak / 20);
    const threshold = (noiseAmp + peakAmp) / 2;
    // Open at the squelch, closed only 3 dB under it: a weak signal's peak wavers.
    this.open = this.peak - this.noise >= this.squelch - (this.open ? 3 : 0);
    const open = this.open;
    const raw = open && (this.down ? amplitude > threshold * 0.9 : amplitude > threshold * 1.1);

    if (raw === this.down) {
      this.pending = 0;
      return -1;
    }
    this.pending += 1;
    if (this.pending * this.tickMs < this.minRunMs) return -1;
    const ago = this.pending;
    this.pending = 0;
    this.down = raw;
    return ago;
  }
}

/**
 * Codes from the lengths of key-down (marks) and key-up (gaps) stretches.
 *
 * The dot length comes from the last marks: two clusters — dots and dashes —
 * found by 2-means, a dash counted as three dots. Until the marks have shown
 * both clusters the speed is a guess, so the stretches heard meanwhile are
 * kept, and once the speed is known they are decoded again from the start:
 * at a guess of 20 words a minute a slow T would end a word, and a fast TH
 * would run together into a 6.
 *
 * A mark under two dots is a dot, over is a dash; a gap over two dots ends a
 * letter, over five a word.
 */
export class TimingDecoder {
  dot: number;
  /** The decoded stream: codes, " " between words, "\n" where the decoder was retuned. */
  readonly tokens: string[] = [];
  /** Bumped on every change of tokens, so a view knows to redraw. */
  revision = 0;
  /** The marks of the letter being received. */
  private marks: number[] = [];
  private readonly history: number[] = [];
  /** The recent gaps inside letters: one dot each. */
  private readonly inner: number[] = [];
  private confident = false;
  /** Before the speed is known: what was heard (a mark > 0, a gap < 0) and where its tokens begin. */
  private heard: number[] = [];
  private heardFrom = 0;
  private down = false;
  private since = 0;
  private spaced = true;

  constructor(wpm = 20) {
    this.dot = 1200 / wpm;
  }

  get wpm(): number {
    return 1200 / this.dot;
  }

  /** Whether the speed has been learned from the signal rather than guessed. */
  get locked(): boolean {
    return this.confident;
  }

  /** The letter being received, as dots and dashes. */
  get symbol(): string {
    return this.marks.map((ms) => this.classify(ms)).join('');
  }

  private classify(ms: number): string {
    return ms < 2 * this.dot ? '.' : '-';
  }

  /** The key went down (`down`) or up at `atMs`. */
  edge(down: boolean, atMs: number): void {
    if (down === this.down) return;
    const ms = atMs - this.since;
    this.down = down;
    this.since = atMs;
    if (!down) this.mark(ms);
    else {
      if (!this.confident) this.heard.push(-ms);
      else if (ms < 2 * this.dot) {
        this.inner.push(ms);
        if (this.inner.length > 16) this.inner.shift();
      }
      this.gap(ms);
    }
  }

  /** Time passes: a long enough gap ends the letter, then the word. */
  tick(nowMs: number): void {
    if (!this.down) this.gap(nowMs - this.since);
  }

  private mark(ms: number): void {
    this.history.push(ms);
    if (this.history.length > 16) this.history.shift();
    if (!this.confident) this.heard.push(ms);
    if (this.learn() && this.heard.length) this.replay();
    else {
      this.marks.push(ms);
      this.spaced = false;
    }
  }

  private gap(ms: number): void {
    if (this.marks.length && ms > 2 * this.dot) this.letter();
    if (!this.spaced && !this.marks.length && ms > 5 * this.dot && this.tokens.length) {
      this.push(' ');
      this.spaced = true;
    }
  }

  /** Decodes again, at the speed just learned, all that was heard before it. */
  private replay(): void {
    const heard = this.heard;
    this.heard = [];
    this.tokens.length = Math.min(this.tokens.length, this.heardFrom);
    this.marks = [];
    this.spaced = !this.tokens.length || this.tokens.at(-1) === ' ' || this.tokens.at(-1) === '\n';
    for (const ms of heard) {
      if (ms > 0) {
        this.marks.push(ms);
        this.spaced = false;
      } else this.gap(-ms);
    }
    this.revision += 1;
  }

  private letter(): void {
    const code = this.marks.map((ms) => this.classify(ms)).join('');
    this.marks = [];
    this.push(code);
  }

  private push(token: string): void {
    this.tokens.push(token);
    if (this.tokens.length > 20000) {
      this.tokens.splice(0, 5000);
      this.heardFrom = Math.max(0, this.heardFrom - 5000);
    }
    this.revision += 1;
  }

  /**
   * 2-means over the recent marks, split in log space: a dash is three times a
   * dot, not two dots longer. True when this is the first time the speed is known.
   */
  private learn(): boolean {
    const marks = this.history;
    if (marks.length < 2) return false;
    let short = Math.min(...marks);
    let long = Math.max(...marks);
    if (long < short * 2) return false;
    let dots: number[] = [];
    let dashes: number[] = [];
    for (let round = 0; round < 8; round++) {
      const split = Math.sqrt(short * long);
      dots = marks.filter((ms) => ms < split);
      dashes = marks.filter((ms) => ms >= split);
      short = dots.reduce((a, b) => a + b, 0) / dots.length;
      long = dashes.reduce((a, b) => a + b, 0) / dashes.length;
    }
    const total = dots.reduce((a, b) => a + b, 0) + dashes.reduce((a, b) => a + b, 0) / 3;
    let dot = total / marks.length;
    // A sender's weighting, and the detector, lengthen marks as much as they shorten the gaps
    // inside a letter: the two together give the dot itself.
    if (this.inner.length >= 4) {
      const sorted = [...this.inner].sort((a, b) => a - b);
      const gap = sorted[sorted.length >> 1] as number;
      if (gap > dot / 2 && gap < dot * 2) dot = (dot + gap) / 2;
    }
    this.dot = Math.min(MAX_DOT_MS, Math.max(MIN_DOT_MS, dot));
    if (this.confident) return false;
    this.confident = true;
    return true;
  }

  /** A new signal: forget the speed, keep what was decoded, marked off by a line break. */
  restart(): void {
    if (this.marks.length) this.letter();
    if (this.tokens.at(-1) === ' ') this.tokens.pop();
    if (this.tokens.length && this.tokens.at(-1) !== '\n') this.push('\n');
    this.history.length = 0;
    this.inner.length = 0;
    this.confident = false;
    this.heard = [];
    this.heardFrom = this.tokens.length;
    this.down = false;
    this.spaced = true;
  }

  clear(): void {
    this.tokens.length = 0;
    this.marks = [];
    this.heard = [];
    this.heardFrom = 0;
    this.spaced = true;
    this.revision += 1;
  }
}

/** The decoded stream as text in `language`. */
export function spell(tokens: readonly string[], language: MorseLanguage): string {
  let out = '';
  for (const token of tokens) out += token === ' ' || token === '\n' ? token : decodeSymbol(token, language);
  return out;
}

export interface ChannelOptions {
  /** Passband, both sides, in Hz. */
  bandwidth: number;
  /** Peak over noise, in dB, below which there is no signal. */
  squelch: number;
  /** The speed to start from until the signal shows its own. */
  wpm?: number;
}

/** A decoder tuned to one frequency. */
export class Channel {
  readonly sampleRate: number;
  frequency: number;
  private demodulator: Demodulator;
  readonly detector: Detector;
  readonly decoder: TimingDecoder;
  private bandwidth: number;
  private ticks = 0;

  constructor(sampleRate: number, frequency: number, options: ChannelOptions) {
    this.sampleRate = sampleRate;
    this.frequency = frequency;
    this.demodulator = new Demodulator(sampleRate, frequency, options.bandwidth);
    this.detector = new Detector(this.demodulator.tickMs, options.squelch);
    this.decoder = new TimingDecoder(options.wpm);
    this.bandwidth = options.bandwidth;
  }

  push(samples: Float32Array): void {
    const { tickMs } = this.demodulator;
    this.demodulator.process(samples, (amplitude) => {
      this.ticks += 1;
      // Spikes shorter than a third of a dot are noise, not marks — once the dot is known.
      this.detector.minRunMs = this.decoder.locked ? Math.min(40, Math.max(10, this.decoder.dot * 0.3)) : 15;
      const ago = this.detector.push(amplitude);
      // The detector decides about the level `lookahead` ticks old: that is the decoder's now.
      const now = this.ticks - DETECTOR.lookahead;
      if (ago >= 0) this.decoder.edge(this.detector.down, (now - ago) * tickMs);
      this.decoder.tick(now * tickMs);
    });
  }

  setBandwidth(bandwidth: number): void {
    this.bandwidth = bandwidth;
    this.demodulator.setBandwidth(bandwidth);
  }

  setSquelch(squelch: number): void {
    this.detector.squelch = squelch;
  }

  /** A correction within the same signal: everything learned is kept. */
  nudge(frequency: number): void {
    this.frequency = frequency;
    this.demodulator.setFrequency(frequency);
  }

  get bandwidthHz(): number {
    return this.bandwidth;
  }

  /** Moves to another signal: its own speed and levels, the text so far kept. */
  retune(frequency: number): void {
    this.frequency = frequency;
    this.demodulator = new Demodulator(this.sampleRate, frequency, this.bandwidth);
    this.detector.reset();
    this.decoder.restart();
  }

  text(language: MorseLanguage): string {
    return spell(this.decoder.tokens, language);
  }
}
