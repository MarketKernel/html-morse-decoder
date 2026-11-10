/**
 * The Morse alphabets: international (Latin) and Russian (Cyrillic).
 *
 * Both share the codes: a Russian letter is sent with the code of a Latin one
 * (А = A, Б = B, В = W…), so a received code means one letter or the other
 * only by the language the listener expects. That is why a decoder keeps the
 * codes it heard, not the letters, and spells them in whichever language is
 * picked — switching the language re-spells everything already decoded.
 *
 * Digits and punctuation are the international ones in both languages; the
 * Russian "......" for a full stop is understood as well.
 */

export type MorseLanguage = 'en' | 'ru';

export const MORSE_LANGUAGES: readonly MorseLanguage[] = ['en', 'ru'];

export function isMorseLanguage(value: unknown): value is MorseLanguage {
  return value === 'en' || value === 'ru';
}

const LATIN: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
};

const CYRILLIC: Record<string, string> = {
  А: '.-', Б: '-...', В: '.--', Г: '--.', Д: '-..', Е: '.', Ж: '...-', З: '--..', И: '..', Й: '.---',
  К: '-.-', Л: '.-..', М: '--', Н: '-.', О: '---', П: '.--.', Р: '.-.', С: '...', Т: '-', У: '..-',
  Ф: '..-.', Х: '....', Ц: '-.-.', Ч: '---.', Ш: '----', Щ: '--.-', Ъ: '--.--', Ы: '-.--', Ь: '-..-',
  Э: '..-..', Ю: '..--', Я: '.-.-',
};

const DIGITS: Record<string, string> = {
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
};

const PUNCTUATION: Record<string, string> = {
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.',
  ')': '-.--.-', '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-',
  '_': '..--.-', '"': '.-..-.', '$': '...-..-', '@': '.--.-.',
};

/** Letters that have no code of their own and are sent as another. */
const ALIASES: Record<string, string> = { Ё: 'Е' };

function invert(...tables: Record<string, string>[]): Map<string, string> {
  const out = new Map<string, string>();
  // Later tables win: a letter of the language takes a code over a punctuation mark.
  for (const table of tables) for (const [char, code] of Object.entries(table)) out.set(code, char);
  return out;
}

const DECODE: Record<MorseLanguage, Map<string, string>> = {
  en: invert(PUNCTUATION, DIGITS, LATIN),
  ru: invert(PUNCTUATION, { '.': '......' }, DIGITS, CYRILLIC),
};

/** What an unknown code is spelled as. */
export const UNKNOWN = '*';

/** The character `code` (".-") stands for in `language`, or UNKNOWN. */
export function decodeSymbol(code: string, language: MorseLanguage): string {
  return DECODE[language].get(code) ?? UNKNOWN;
}

/** The code of one character of either alphabet, or null: there is none. */
export function codeOf(char: string): string | null {
  const upper = char.toUpperCase();
  const key = ALIASES[upper] ?? upper;
  return LATIN[key] ?? CYRILLIC[key] ?? DIGITS[key] ?? PUNCTUATION[key] ?? null;
}

export interface Coded {
  /** Index of the character in the text. */
  index: number;
  char: string;
  /** Its code, or null for a character Morse has no code for (skipped when sent). */
  code: string | null;
}

/** The text, character by character with its code; whitespace runs become one " " with no code. */
export function encode(text: string): Coded[] {
  const out: Coded[] = [];
  let index = 0;
  for (const char of text) {
    if (/\s/.test(char)) {
      if (out.length && out.at(-1)?.char !== ' ') out.push({ index, char: ' ', code: null });
    } else out.push({ index, char, code: codeOf(char) });
    index += char.length;
  }
  while (out.at(-1)?.char === ' ') out.pop();
  return out;
}

/** The text as dots and dashes: letters apart by a space, words by " / ". */
export function toCode(text: string): string {
  const words: string[][] = [[]];
  for (const { char, code } of encode(text)) {
    if (char === ' ') words.push([]);
    else if (code) words.at(-1)?.push(code);
  }
  return words
    .filter((word) => word.length)
    .map((word) => word.join(' '))
    .join(' / ');
}

/** One stretch of the key: down (a tone) or up (silence). */
export interface Segment {
  on: boolean;
  ms: number;
  /** Index in the text of the character being sent (the one that follows, for a gap). */
  index: number;
}

/** The length of a dot at `wpm` words a minute, by the word PARIS (50 dots long). */
export function dotMs(wpm: number): number {
  return 1200 / wpm;
}

/**
 * The text as the key sends it: a dot is one unit down, a dash three; one unit
 * up between the elements of a character, three between characters, seven
 * between words. Starts with a tone, ends with one; adjacent gaps are merged.
 */
export function timeline(text: string, wpm: number): Segment[] {
  const unit = dotMs(wpm);
  const out: Segment[] = [];
  const gap = (units: number, index: number) => {
    if (!out.length) return;
    const last = out.at(-1);
    if (last && !last.on) last.ms = Math.max(last.ms, units * unit);
    else out.push({ on: false, ms: units * unit, index });
  };
  let pendingWord = false;
  for (const { index, char, code } of encode(text)) {
    if (char === ' ') {
      pendingWord = true;
      continue;
    }
    if (!code) continue;
    gap(pendingWord ? 7 : 3, index);
    pendingWord = false;
    [...code].forEach((element, i) => {
      if (i) gap(1, index);
      out.push({ on: true, ms: (element === '-' ? 3 : 1) * unit, index });
    });
  }
  return out;
}
