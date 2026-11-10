/** The spectrum: a sine lands in its bin at its level. */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const { Spectrum } = await load('core/fft');

const N = 4096;
const SR = 48000;
const spectrum = new Spectrum(N);
const tone = (hz, amplitude) => Float32Array.from({ length: N }, (_, n) => amplitude * Math.sin((2 * Math.PI * hz * n) / SR));
const peak = (levels) => levels.indexOf(Math.max(...levels));

const bin = 60; // 703.125 Hz, exactly on a bin
const levels = spectrum.levels(tone((bin * SR) / N, 1));
check('peak bin', peak(levels), bin);
check('full scale is 0 dB', Math.round(levels[bin] * 10) / 10, 0);
check('-20 dB', Math.round(spectrum.levels(tone((bin * SR) / N, 0.1))[bin]), -20);
check('far bins are quiet', levels[bin + 50] < -100, true);
check('1000 Hz', Math.round((peak(spectrum.levels(tone(1000, 0.5))) * SR) / N / 20) * 20, 1000);

// Read as a ring: the same block rotated, started at its oldest sample, gives the same spectrum.
const block = tone(1500, 0.3);
const rotated = new Float32Array(N);
rotated.set(block.subarray(1000), 0);
rotated.set(block.subarray(0, 1000), N - 1000);
const a = spectrum.levels(block);
const b = spectrum.levels(rotated, N - 1000);
check('ring start', Math.max(...a.map((v, i) => Math.abs(v - b[i]))) < 1e-3, true);

let threw = false;
try {
  new Spectrum(1000);
} catch {
  threw = true;
}
check('size must be a power of two', threw, true);

done('fft');
