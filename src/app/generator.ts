/**
 * The generator: a text as Morse, out of the speakers and/or straight into the
 * decoder. Every Play starts one more transmission with the tone and speed set
 * at that moment, so two at once, on two tones, are two clicks away — the case
 * the two decoders are for.
 *
 * A transmission is an oscillator under a gain whose envelope is scheduled
 * ahead on the audio clock: raised-cosine edges of RAMP_MS, the shape the
 * tests synthesize, so nothing clicks and the spectrum stays narrow. Repeating
 * schedules the next round shortly before the current one ends.
 */
import { t, tn } from '../core/i18n';
import { encode, type Segment, timeline } from '../core/morse';
import { type GeneratorSettings, TEXT_LIMIT, TONE, WPM } from '../core/settings';
import { RAMP_MS } from '../core/synth';
import type { AudioEngine } from './audio';
import { byId, toast } from './ui';

const CURVE = 32;
const RISE = Float32Array.from({ length: CURVE }, (_, i) => 0.5 - 0.5 * Math.cos((Math.PI * i) / (CURVE - 1)));
const FALL = RISE.slice().reverse();

class Transmission {
  readonly text: string;
  private readonly engine: AudioEngine;
  private readonly osc: OscillatorNode;
  private readonly envelope: GainNode;
  private readonly volume: GainNode;
  private readonly segments: Segment[];
  /** One round and the word gap after it, in seconds. */
  private readonly round: number;
  private readonly loop: boolean;
  private readonly started: number;
  private next: number;
  private timer = 0;
  private hear = false;
  private feed = false;
  ended = false;

  constructor(engine: AudioEngine, text: string, settings: GeneratorSettings, onEnd: (transmission: Transmission) => void) {
    this.engine = engine;
    this.text = text;
    const { ctx } = engine;
    this.segments = timeline(text, settings.wpm);
    const unit = 1.2 / settings.wpm;
    this.round = this.segments.reduce((sum, { ms }) => sum + ms, 0) / 1000 + 7 * unit;
    this.loop = settings.loop;
    this.osc = ctx.createOscillator();
    this.osc.frequency.value = settings.tone;
    this.envelope = ctx.createGain();
    this.envelope.gain.value = 0;
    this.volume = ctx.createGain();
    this.volume.gain.value = settings.volume;
    this.osc.connect(this.envelope).connect(this.volume);
    this.route(settings.hear, settings.feed);
    // A little ahead, so the first edge is not in the past by the time it is scheduled.
    this.started = ctx.currentTime + 0.08;
    this.next = this.started;
    this.schedule();
    if (this.loop) this.scheduleAhead();
    this.osc.start(this.started);
    this.osc.onended = () => {
      this.ended = true;
      this.osc.disconnect();
      this.volume.disconnect();
      onEnd(this);
    };
    if (this.loop) this.timer = window.setInterval(() => this.scheduleAhead(), 250);
    else this.osc.stop(this.next);
  }

  /** Repeating: as many rounds as reach 1.5 s ahead — a short text is many a round. */
  private scheduleAhead(): void {
    while (this.engine.ctx.currentTime > this.next - 1.5) this.schedule();
  }

  private schedule(): void {
    const gain = this.envelope.gain;
    const ramp = RAMP_MS / 1000;
    let at = this.next;
    for (const { on, ms } of this.segments) {
      const length = ms / 1000;
      if (on) {
        gain.setValueCurveAtTime(RISE, at, ramp);
        gain.setValueCurveAtTime(FALL, at + length - ramp, ramp);
      }
      at += length;
    }
    this.next += this.round;
  }

  route(hear: boolean, feed: boolean): void {
    if (hear !== this.hear) {
      if (hear) this.volume.connect(this.engine.ctx.destination);
      else this.volume.disconnect(this.engine.ctx.destination);
      this.hear = hear;
    }
    if (feed !== this.feed) {
      if (feed) this.volume.connect(this.engine.input);
      else this.volume.disconnect(this.engine.input);
      this.feed = feed;
    }
  }

  setVolume(volume: number): void {
    this.volume.gain.setTargetAtTime(volume, this.engine.ctx.currentTime, 0.02);
  }

  stop(): void {
    if (this.ended) return;
    clearInterval(this.timer);
    const now = this.engine.ctx.currentTime;
    const gain = this.envelope.gain;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(0, now, 0.004);
    this.osc.stop(now + 0.05);
  }

  /** The index in the text of the character on the air now, or -1 in a gap between rounds. */
  position(): number {
    let at = (this.engine.ctx.currentTime - this.started) * 1000;
    if (at < 0) return -1;
    at %= this.round * 1000;
    for (const { ms, index } of this.segments) {
      if (at < ms) return index;
      at -= ms;
    }
    return -1;
  }
}

export class Generator {
  private readonly settings: GeneratorSettings;
  private readonly getEngine: () => Promise<AudioEngine>;
  private readonly onChange: () => void;
  private readonly text = byId<HTMLTextAreaElement>('gen-text');
  private readonly code = byId('gen-code');
  private readonly wpm = byId<HTMLInputElement>('gen-wpm');
  private readonly wpmValue = byId<HTMLOutputElement>('gen-wpm-value');
  private readonly tone = byId<HTMLInputElement>('gen-tone');
  private readonly volume = byId<HTMLInputElement>('gen-volume');
  private readonly volumeValue = byId<HTMLOutputElement>('gen-volume-value');
  private readonly noise = byId<HTMLInputElement>('gen-noise');
  private readonly noiseValue = byId<HTMLOutputElement>('gen-noise-value');
  private readonly hear = byId<HTMLInputElement>('gen-hear');
  private readonly feed = byId<HTMLInputElement>('gen-feed');
  private readonly loop = byId<HTMLInputElement>('gen-loop');
  private readonly play = byId<HTMLButtonElement>('gen-play');
  private readonly stop = byId<HTMLButtonElement>('gen-stop');
  private readonly status = byId('gen-status');
  private transmissions: Transmission[] = [];
  private chars: HTMLElement[] = [];
  private active = -1;
  private engine: AudioEngine | null = null;

  constructor(settings: GeneratorSettings, getEngine: () => Promise<AudioEngine>, onChange: () => void) {
    this.settings = settings;
    this.getEngine = getEngine;
    this.onChange = onChange;

    this.text.maxLength = TEXT_LIMIT;
    this.text.value = settings.text;
    this.wpm.min = String(WPM.min);
    this.wpm.max = String(WPM.max);
    this.wpm.value = String(settings.wpm);
    this.tone.min = String(TONE.min);
    this.tone.max = String(TONE.max);
    this.tone.value = String(settings.tone);
    this.volume.value = String(settings.volume);
    this.noise.value = String(settings.noise);
    this.hear.checked = settings.hear;
    this.feed.checked = settings.feed;
    this.loop.checked = settings.loop;

    this.text.addEventListener('input', () => {
      settings.text = this.text.value;
      this.renderCode();
      onChange();
    });
    this.wpm.addEventListener('input', () => {
      settings.wpm = Number(this.wpm.value);
      this.renderValues();
      onChange();
    });
    this.tone.addEventListener('change', () => {
      const value = Math.round(Number(this.tone.value));
      settings.tone = Number.isFinite(value) ? Math.min(TONE.max, Math.max(TONE.min, value)) : TONE.default;
      this.tone.value = String(settings.tone);
      onChange();
    });
    this.volume.addEventListener('input', () => {
      settings.volume = Number(this.volume.value);
      for (const transmission of this.transmissions) transmission.setVolume(settings.volume);
      this.renderValues();
      onChange();
    });
    this.noise.addEventListener('input', () => {
      settings.noise = Number(this.noise.value);
      this.renderValues();
      if (this.engine) this.engine.setNoise(settings.noise);
      else if (settings.noise > 0) void this.getEngine().then((engine) => engine.setNoise(settings.noise));
      onChange();
    });
    for (const box of [this.hear, this.feed]) {
      box.addEventListener('change', () => {
        settings.hear = this.hear.checked;
        settings.feed = this.feed.checked;
        for (const transmission of this.transmissions) transmission.route(settings.hear, settings.feed);
        onChange();
      });
    }
    this.loop.addEventListener('change', () => {
      settings.loop = this.loop.checked;
      onChange();
    });
    this.play.addEventListener('click', () => void this.start());
    this.stop.addEventListener('click', () => this.stopAll());
    this.renderValues();
    this.renderCode();
    this.renderStatus();
  }

  private async start(): Promise<void> {
    const text = this.text.value;
    if (!timeline(text, this.settings.wpm).length) {
      toast(t('generator', 'Type something to send: Latin or Cyrillic letters, digits, punctuation'));
      return;
    }
    if (!this.settings.hear && !this.settings.feed) {
      toast(t('generator', 'Turn on the speakers or the decoder: otherwise it plays to no one'));
      return;
    }
    const engine = await this.getEngine();
    this.engine = engine;
    const transmission = new Transmission(engine, text, this.settings, (ended) => {
      this.transmissions = this.transmissions.filter((other) => other !== ended);
      this.renderStatus();
    });
    this.transmissions.push(transmission);
    this.renderStatus();
  }

  stopAll(): void {
    for (const transmission of this.transmissions) transmission.stop();
  }

  private renderValues(): void {
    this.wpmValue.value = t('generator', '{wpm} WPM', { wpm: this.settings.wpm });
    this.volumeValue.value = `${Math.round(this.settings.volume * 100)}%`;
    this.noiseValue.value = `${Math.round(this.settings.noise * 100)}%`;
  }

  private renderStatus(): void {
    const count = this.transmissions.length;
    this.stop.disabled = count === 0;
    this.status.textContent = count ? tn('generator', '{count} transmission on the air', '{count} transmissions on the air', count) : '';
  }

  /** The text, character by character with its code under it. */
  private renderCode(): void {
    this.active = -1;
    this.chars = [];
    const nodes = encode(this.text.value).map(({ index, char, code }) => {
      const cell = document.createElement('span');
      cell.className = 'gen-char';
      if (char === ' ') cell.classList.add('is-space');
      else {
        if (!code) {
          cell.classList.add('is-unknown');
          cell.title = t('generator', 'Morse has no code for this character: it is skipped');
        }
        const letter = document.createElement('b');
        letter.textContent = char;
        const dots = document.createElement('i');
        dots.textContent = code ? code.replaceAll('.', '·').replaceAll('-', '−') : '∅';
        cell.append(letter, dots);
      }
      this.chars[index] = cell;
      return cell;
    });
    this.code.replaceChildren(...nodes);
  }

  /** Lights the character on the air in the newest transmission of the text as typed now. */
  tick(): void {
    const current = [...this.transmissions].reverse().find((transmission) => transmission.text === this.text.value);
    const index = current ? current.position() : -1;
    if (index === this.active) return;
    this.chars[this.active]?.classList.remove('is-active');
    this.chars[index]?.classList.add('is-active');
    this.active = index;
  }

  retranslate(): void {
    this.renderValues();
    this.renderStatus();
    this.renderCode();
  }
}
