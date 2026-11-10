/**
 * The whole receiving chain on synthesized sound: two signals at once, in two
 * languages, at many speeds, in noise; and noise alone, which must stay silent.
 * The noise is seeded, so these results are the same on every run.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const R = await load('core/receiver', 'core/synth', 'core/decoder');
const SR = 48000;

/** Feeds `samples` in blocks as the page does, returns the receiver. */
function receive(samples, frequencies, options = {}) {
  const receiver = new R.Receiver({ sampleRate: SR, bandwidth: 100, squelch: 8, ...options });
  frequencies.forEach((frequency, slot) => receiver.tune(slot, frequency));
  for (let i = 0; i < samples.length; i += 2048) receiver.push(samples.subarray(i, i + 2048));
  return receiver;
}

const EN = 'CQ CQ DE TEST 73 PARIS 1234567890';
const RU = 'ПРИВЕТ МИР ЭТО ПРОВЕРКА СВЯЗИ';
const pair = (noise) =>
  R.render(SR, [
    { text: EN, wpm: 20, frequency: 700, amplitude: 0.1 },
    { text: RU, wpm: 15, frequency: 1000, amplitude: 0.1, delayMs: 300 },
  ], noise);

for (const noise of [0, 0.1, 0.2]) {
  const [a, b] = receive(pair(noise), [700, 1000]).channels;
  check(`two signals, noise ${noise}: A`, a.text('en').trim(), EN);
  check(`two signals, noise ${noise}: B`, b.text('ru').trim(), RU);
  check(`two signals, noise ${noise}: speed A`, Math.round(a.decoder.wpm), 20);
  check(`two signals, noise ${noise}: speed B`, Math.round(b.decoder.wpm), 15);
}

// From a moment of silence: a 5 WPM dash, 720 ms, tuned into from its first moment, is longer
// than the detector looks ahead and could be a dot of a louder signal. (Signal A above is
// there from the start: tuning into a station already on the air works at usual speeds.)
const FOX = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG';
for (const wpm of [5, 10, 25, 35, 50]) {
  const [channel] = receive(R.render(SR, [{ text: FOX, wpm, frequency: 800, amplitude: 0.1, delayMs: 300 }], 0.02), [800]).channels;
  check(`${wpm} wpm`, channel.text('en').trim(), FOX);
  check(`${wpm} wpm: speed learned`, Math.abs(channel.decoder.wpm - wpm) / wpm < 0.08, true);
}

// The same codes spelled in the other language.
{
  const [channel] = receive(R.render(SR, [{ text: 'WAVE', wpm: 20, frequency: 600, amplitude: 0.2 }]), [600]).channels;
  check('spelled in english', channel.text('en').trim(), 'WAVE');
  check('the same, in russian', channel.text('ru').trim(), 'ВАЖЕ');
}

// A narrow filter hears through more noise.
{
  const [channel] = receive(R.render(SR, [{ text: EN, wpm: 18, frequency: 700, amplitude: 0.1 }], 0.3, 1500, 7), [700], { bandwidth: 50 }).channels;
  check('50 Hz filter, noise 0.3', channel.text('en').trim(), EN);
}

// Off frequency: a decoder 300 Hz away hears nothing.
{
  const [, off] = receive(R.render(SR, [{ text: EN, wpm: 20, frequency: 700, amplitude: 0.3 }], 0.02), [700, 1000]).channels;
  check('300 Hz away hears nothing', off.text('en'), '');
}

// Noise alone: nothing, or nearly, decoded.
{
  const quiet = new Float32Array(SR * 20);
  R.addNoise(quiet, 0.3, 3);
  const channels = receive(quiet, [700, 1000, 1500]).channels;
  const letters = channels.map((c) => c.text('en').replace(/\s/g, '').length);
  check('noise alone: nothing decoded', letters, [0, 0, 0]);
}

// Retuning keeps the text, marked off by a line break, and learns the new speed.
{
  const samples = R.render(SR, [
    { text: 'AAA', wpm: 25, frequency: 700, amplitude: 0.1 },
    { text: 'NNN', wpm: 12, frequency: 1100, amplitude: 0.1, delayMs: 2500 },
  ]);
  const receiver = new R.Receiver({ sampleRate: SR, bandwidth: 100, squelch: 8 });
  receiver.tune(0, 700);
  const cut = SR * 2;
  receiver.push(samples.subarray(0, cut));
  receiver.tune(0, 1100);
  receiver.push(samples.subarray(cut));
  check('retune', receiver.channels[0].text('en').trim(), 'AAA\nNNN');
  check('retune: new speed', Math.round(receiver.channels[0].decoder.wpm), 12);
}

// A correction within the passband keeps the decoder's state; the text has no break.
{
  const samples = R.render(SR, [{ text: 'PARIS PARIS', wpm: 20, frequency: 700, amplitude: 0.1 }], 0.02);
  const receiver = new R.Receiver({ sampleRate: SR, bandwidth: 100, squelch: 8 });
  receiver.tune(0, 690);
  const cut = SR * 2;
  receiver.push(samples.subarray(0, cut));
  receiver.tune(0, 702);
  receiver.push(samples.subarray(cut));
  check('nudge', receiver.channels[0].text('en').trim(), 'PARIS PARIS');
  check('nudge: frequency', receiver.channels[0].frequency, 702);
}

// The spectrum: a click near a signal snaps to it.
{
  const receiver = receive(R.render(SR, [{ text: 'TTTTT', wpm: 10, frequency: 913, amplitude: 0.2 }], 0.01), []);
  check('snap to the signal', Math.abs(receiver.snap(880, 60) - 913) < 3, true);
  check('nothing to snap to', receiver.snap(2000, 60), 2000);
  check('frames', receiver.average.length, 2048);
}

// spell(): line breaks and spaces pass through, unknown codes become *.
check('spell', R.spell(['....', '..', ' ', '.-.-.-.-', '\n', '-'], 'en'), 'HI *\nT');

done('receiver');
