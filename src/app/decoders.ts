/**
 * A decoder's card: its frequency, alphabet, speed, signal level and the text.
 *
 * The text is redrawn only when the decoder has something new or the alphabet
 * changed — then the whole of it is spelled again from the codes heard, so a
 * signal decoded as English reads as Russian the moment Cyrillic is picked.
 */
import type { Channel } from '../core/decoder';
import { t, tn, translatePage } from '../core/i18n';
import type { MorseLanguage } from '../core/morse';
import { find, toast } from './ui';

export interface DecoderHandlers {
  onLanguage(slot: number, language: MorseLanguage): void;
  onFrequency(slot: number, frequency: number): void;
  onOff(slot: number): void;
  onActivate(slot: number): void;
  onClear(slot: number): void;
}

const NAMES = ['A', 'B'];
/** dB of signal over noise that fill the meter. */
const METER_DB = 30;

const pretty = (symbol: string) => symbol.replaceAll('.', '·').replaceAll('-', '−');

export class DecoderView {
  readonly slot: number;
  readonly element: HTMLElement;
  private readonly frequency: HTMLInputElement;
  private readonly language: HTMLSelectElement;
  private readonly led: HTMLElement;
  private readonly wpm: HTMLElement;
  private readonly meter: HTMLElement;
  private readonly meterFill: HTMLElement;
  private readonly snr: HTMLElement;
  private readonly body: HTMLElement;
  private readonly out: HTMLElement;
  private readonly symbol: HTMLElement;
  private readonly empty: HTMLElement;
  private channel: Channel | null = null;
  private shown = { revision: -1, language: '', channel: null as Channel | null, symbol: '' };
  private text = '';

  constructor(slot: number, container: HTMLElement, language: MorseLanguage, handlers: DecoderHandlers) {
    this.slot = slot;
    const template = document.getElementById('decoder-template') as HTMLTemplateElement;
    const element = template.content.firstElementChild?.cloneNode(true);
    if (!(element instanceof HTMLElement)) throw new Error('The decoder template is empty');
    this.element = element;
    element.dataset.slot = String(slot);
    container.append(element);
    translatePage(element);

    const badge = find(element, '.decoder-badge');
    badge.textContent = NAMES[slot] ?? String(slot);
    badge.addEventListener('click', () => handlers.onActivate(slot));
    this.frequency = find<HTMLInputElement>(element, '.decoder-freq-input');
    this.frequency.min = '50';
    this.frequency.max = '8000';
    this.language = find<HTMLSelectElement>(element, '.decoder-lang');
    this.language.value = language;
    this.led = find(element, '.decoder-led');
    this.wpm = find(element, '.decoder-wpm');
    this.meter = find(element, '.decoder-meter');
    this.meterFill = find(element, '.decoder-meter-fill');
    this.snr = find(element, '.decoder-snr');
    this.body = find(element, '.decoder-body');
    this.out = find(element, '.decoder-out');
    this.symbol = find(element, '.decoder-symbol');
    this.empty = find(element, '.decoder-empty');

    this.language.addEventListener('change', () => handlers.onLanguage(slot, this.language.value === 'ru' ? 'ru' : 'en'));
    this.frequency.addEventListener('change', () => {
      const value = Number(this.frequency.value);
      if (Number.isFinite(value) && value >= 50 && value <= 8000) handlers.onFrequency(slot, value);
      else if (this.channel) this.frequency.value = String(Math.round(this.channel.frequency));
    });
    find(element, '.decoder-copy').addEventListener('click', () => void this.copy());
    find(element, '.decoder-clear').addEventListener('click', () => handlers.onClear(slot));
    find(element, '.decoder-off').addEventListener('click', () => handlers.onOff(slot));
    element.addEventListener('pointerdown', () => handlers.onActivate(slot));
    this.update(null, language, slot === 0);
  }

  private async copy(): Promise<void> {
    const text = this.text.trim();
    if (!text) {
      toast(t('decoder', 'Nothing decoded yet'));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(tn('decoder', '{count} character copied', '{count} characters copied', [...text].length));
    } catch {
      toast(t('decoder', 'The browser did not allow copying'), 'error');
    }
  }

  /** Called a few times a second, and at once after a change. */
  update(channel: Channel | null, language: MorseLanguage, active: boolean): void {
    this.channel = channel;
    this.element.classList.toggle('is-active', active);
    this.element.classList.toggle('is-off', !channel);
    if (this.language.value !== language) this.language.value = language;

    if (!channel) {
      this.led.classList.remove('is-on');
      if (this.shown.channel !== null || this.shown.language !== `${language}|off`) {
        this.out.textContent = '';
        this.symbol.textContent = '';
        this.text = '';
        this.frequency.value = '';
        this.shown = { revision: -1, language: `${language}|off`, channel: null, symbol: '' };
      }
      this.empty.hidden = false;
      this.empty.textContent =
        this.slot === 0
          ? t('decoder', 'Click a signal on the waterfall to decode it.')
          : t('decoder', 'For a second signal: Shift-click it, or pick B above and click.');
      return;
    }

    const { decoder, detector } = channel;
    if (document.activeElement !== this.frequency) {
      const value = String(Math.round(channel.frequency));
      if (this.frequency.value !== value) this.frequency.value = value;
    }
    this.led.classList.toggle('is-on', detector.down);
    this.wpm.textContent = decoder.locked ? t('decoder', '{wpm} WPM', { wpm: Math.round(decoder.wpm) }) : t('decoder', '— WPM');
    const snr = detector.snr;
    this.meterFill.style.width = `${Math.min(100, (snr / METER_DB) * 100)}%`;
    this.meter.classList.toggle('is-closed', !detector.open);
    // A generated signal fed straight in has no noise at all: 140 dB says nothing more than 60.
    this.snr.textContent = t('decoder', '{db} dB', { db: snr > 60 ? '60+' : Math.round(snr) });

    const symbol = pretty(decoder.symbol);
    const fresh = decoder.revision !== this.shown.revision || language !== this.shown.language || channel !== this.shown.channel;
    if (!fresh && symbol === this.shown.symbol) return;
    const atBottom = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 24;
    if (fresh) {
      this.text = channel.text(language);
      this.out.textContent = this.text;
    }
    this.symbol.textContent = symbol;
    this.shown = { revision: decoder.revision, language, channel, symbol };
    this.empty.hidden = Boolean(this.text || symbol);
    this.empty.textContent = t('decoder', 'Listening…');
    if (atBottom) this.body.scrollTop = this.body.scrollHeight;
  }

  /** After the interface language changed: the texts made in code. */
  retranslate(): void {
    this.shown.language = '';
  }
}
