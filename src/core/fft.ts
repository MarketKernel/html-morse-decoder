/**
 * The spectrum of a block of samples: a radix-2 FFT under a Hann window.
 *
 * One instance per size keeps the window, the twiddle factors and the
 * bit-reversal table, so a frame costs only the butterflies.
 */

export class Spectrum {
  readonly size: number;
  private readonly window: Float32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly reversed: Uint32Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two, not ${size}`);
    this.size = size;
    this.window = new Float32Array(size);
    for (let i = 0; i < size; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    this.reversed = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.reversed[i] = r;
    }
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
  }

  /**
   * The level of each frequency bin 0…size/2-1 in dB, a full-scale sine at 0 dB.
   * `samples` is read as a ring: the oldest sample at `start`.
   */
  levels(samples: Float32Array, start = 0, out: Float32Array = new Float32Array(this.size / 2)): Float32Array {
    const { size, re, im, reversed, window } = this;
    for (let i = 0; i < size; i++) {
      const j = reversed[i] as number;
      re[j] = (samples[(start + i) % samples.length] as number) * (window[i] as number);
      im[j] = 0;
    }
    for (let half = 1; half < size; half *= 2) {
      const step = size / (half * 2);
      for (let block = 0; block < size; block += half * 2) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step] as number;
          const s = this.sin[k * step] as number;
          const a = block + k;
          const b = a + half;
          const br = re[b] as number;
          const bi = im[b] as number;
          const tr = br * c - bi * s;
          const ti = br * s + bi * c;
          re[b] = (re[a] as number) - tr;
          im[b] = (im[a] as number) - ti;
          re[a] = (re[a] as number) + tr;
          im[a] = (im[a] as number) + ti;
        }
      }
    }
    // A sine of amplitude A peaks at A·size/4 under the Hann window.
    const scale = 4 / size;
    for (let i = 0; i < size / 2; i++) {
      const magnitude = Math.hypot(re[i] as number, im[i] as number) * scale;
      out[i] = 20 * Math.log10(magnitude + 1e-12);
    }
    return out;
  }
}
