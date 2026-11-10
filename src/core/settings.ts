/**
 * The page's settings, kept in localStorage as one JSON object. Every field is
 * checked when read: one that is missing, unknown or broken takes its default,
 * and the rest are kept.
 */
import { isLanguage, type Language } from './i18n';
import { isMorseLanguage, type MorseLanguage } from './morse';

export const STORAGE_KEY = 'morse-decoder';

/** The decoders' passbands, Hz. Narrower hears weaker signals, wider follows faster ones. */
export const BANDWIDTHS = [50, 100, 200] as const;
export type Bandwidth = (typeof BANDWIDTHS)[number];

/** What the waterfall shows, Hz: around the usual CW tones, or the whole voice band. */
export const SPANS = {
  cw: [200, 1400],
  voice: [0, 3000],
  wide: [0, 6000],
} as const satisfies Record<string, readonly [number, number]>;
export type Span = keyof typeof SPANS;

export const SQUELCH = { min: 3, max: 30, default: 8 } as const;
export const WPM = { min: 5, max: 50, default: 18 } as const;
export const TONE = { min: 200, max: 3000, default: 700 } as const;
export const TEXT_LIMIT = 2000;

export type Theme = 'system' | 'light' | 'dark';

export interface GeneratorSettings {
  text: string;
  wpm: number;
  tone: number;
  /** 0…1 */
  volume: number;
  /** Out of the speakers. */
  hear: boolean;
  /** Straight into the decoder, without the speakers and the microphone. */
  feed: boolean;
  loop: boolean;
  /** White noise into the decoder, 0…1, to try it on weak signals. */
  noise: number;
}

export interface Settings {
  language: 'system' | Language;
  theme: Theme;
  bandwidth: Bandwidth;
  span: Span;
  squelch: number;
  /** Each decoder's alphabet. */
  decoders: [MorseLanguage, MorseLanguage];
  generator: GeneratorSettings;
}

export function defaults(morse: MorseLanguage = 'en'): Settings {
  return {
    language: 'system',
    theme: 'system',
    bandwidth: 100,
    span: 'cw',
    squelch: SQUELCH.default,
    decoders: [morse, morse],
    generator: {
      text: morse === 'ru' ? 'ПРИВЕТ МИР' : 'CQ CQ DE TEST K',
      wpm: WPM.default,
      tone: TONE.default,
      volume: 0.5,
      hear: true,
      feed: true,
      loop: false,
      noise: 0,
    },
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const number = (value: unknown, min: number, max: number, fallback: number, step = 0): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(max, Math.max(min, value));
  return step ? Math.round(clamped / step) * step : clamped;
};

const boolean = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

/** Settings from what localStorage holds, which may be anything. */
export function parseSettings(stored: string | null, morse: MorseLanguage = 'en'): Settings {
  const base = defaults(morse);
  let raw: unknown = null;
  try {
    raw = stored ? JSON.parse(stored) : null;
  } catch {
    raw = null;
  }
  const s = record(raw);
  const g = record(s.generator);
  const decoders = Array.isArray(s.decoders) ? s.decoders : [];
  return {
    language: s.language === 'system' || isLanguage(s.language) ? s.language : base.language,
    theme: s.theme === 'light' || s.theme === 'dark' || s.theme === 'system' ? s.theme : base.theme,
    bandwidth: BANDWIDTHS.find((b) => b === s.bandwidth) ?? base.bandwidth,
    span: typeof s.span === 'string' && Object.hasOwn(SPANS, s.span) ? (s.span as Span) : base.span,
    squelch: number(s.squelch, SQUELCH.min, SQUELCH.max, base.squelch, 1),
    decoders: [0, 1].map((i) => (isMorseLanguage(decoders[i]) ? decoders[i] : base.decoders[i])) as [MorseLanguage, MorseLanguage],
    generator: {
      text: typeof g.text === 'string' ? g.text.slice(0, TEXT_LIMIT) : base.generator.text,
      wpm: number(g.wpm, WPM.min, WPM.max, base.generator.wpm, 1),
      tone: number(g.tone, TONE.min, TONE.max, base.generator.tone, 1),
      volume: number(g.volume, 0, 1, base.generator.volume),
      hear: boolean(g.hear, base.generator.hear),
      feed: boolean(g.feed, base.generator.feed),
      loop: boolean(g.loop, base.generator.loop),
      noise: number(g.noise, 0, 1, base.generator.noise),
    },
  };
}
