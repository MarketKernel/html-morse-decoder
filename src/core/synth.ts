/**
 * Morse as samples, for the tests: the same shape of tone the generator plays
 * (raised-cosine edges, so no clicks spread over the spectrum), white noise
 * from a seeded generator so a failing test fails the same way every time.
 */
import { type Segment, timeline } from './morse';

/** Edges of 5 ms: a clean spectrum, and still a fifth of a dot at 48 words a minute. */
export const RAMP_MS = 5;

export interface Tone {
  text: string;
  wpm: number;
  frequency: number;
  amplitude: number;
  /** Silence before the first tone. */
  delayMs?: number;
}

/** The envelope's height at `t` ms into a tone of `length` ms. */
export function envelope(t: number, length: number, ramp = RAMP_MS): number {
  if (t < 0 || t > length) return 0;
  const edge = Math.min(t, length - t, ramp);
  return edge >= ramp ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / ramp);
}

/** Adds the tone of `segments` into `out`. */
export function addTone(out: Float32Array, sampleRate: number, segments: Segment[], tone: Omit<Tone, 'text' | 'wpm'>): void {
  let at = tone.delayMs ?? 0;
  const step = (2 * Math.PI * tone.frequency) / sampleRate;
  for (const { on, ms } of segments) {
    if (on) {
      const from = Math.round((at * sampleRate) / 1000);
      const to = Math.min(out.length, Math.round(((at + ms) * sampleRate) / 1000));
      for (let n = from; n < to; n++) {
        const t = ((n - from) * 1000) / sampleRate;
        out[n] = (out[n] as number) + tone.amplitude * envelope(t, ms) * Math.sin(step * n);
      }
    }
    at += ms;
  }
}

export function durationMs(segments: Segment[]): number {
  return segments.reduce((sum, { ms }) => sum + ms, 0);
}

/** A seeded uniform generator (mulberry32). */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adds Gaussian white noise of standard deviation `sigma`. */
export function addNoise(out: Float32Array, sigma: number, seed = 1): void {
  const next = random(seed);
  for (let n = 0; n < out.length; n++) {
    const u = Math.max(next(), 1e-12);
    const v = next();
    out[n] = (out[n] as number) + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** Several transmissions at once, with noise, `tailMs` of silence after the longest. */
export function render(sampleRate: number, tones: Tone[], noise = 0, tailMs = 1500, seed = 1): Float32Array {
  const plans = tones.map((tone) => ({ tone, segments: timeline(tone.text, tone.wpm) }));
  const length = Math.max(...plans.map(({ tone, segments }) => (tone.delayMs ?? 0) + durationMs(segments))) + tailMs;
  const out = new Float32Array(Math.ceil((length * sampleRate) / 1000));
  for (const { tone, segments } of plans) addTone(out, sampleRate, segments, tone);
  if (noise) addNoise(out, noise, seed);
  return out;
}
