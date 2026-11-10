/**
 * The alphabets and the key's timing. These vectors are the standard and must
 * not change: a code that moves breaks every decoder listening to it.
 */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const M = await load('core/morse');

check('latin letters', M.toCode('SOS'), '... --- ...');
check('words apart', M.toCode('CQ  DE\nUT1A'), '-.-. --.- / -.. . / ..- - .---- .-');
check('lower case', M.toCode('paris'), M.toCode('PARIS'));
check('digits', M.toCode('0123456789'), '----- .---- ..--- ...-- ....- ..... -.... --... ---.. ----.');
check('punctuation', M.toCode('.,?/=+-'), '.-.-.- --..-- ..--.. -..-. -...- .-.-. -....-');
check('cyrillic', M.toCode('АБВГДЕЖЗИЙКЛМНОП'), '.- -... .-- --. -.. . ...- --.. .. .--- -.- .-.. -- -. --- .--.');
check('cyrillic 2', M.toCode('РСТУФХЦЧШЩЪЫЬЭЮЯ'), '.-. ... - ..- ..-. .... -.-. ---. ---- --.- --.-- -.-- -..- ..-.. ..-- .-.-');
check('Ё is sent as Е', M.toCode('ёЁ'), '. .');
check('unknown characters are skipped', M.toCode('A#B'), '.- -...');
check('empty', M.toCode('  '), '');

// Decoding: the same code, a letter of the language the listener expects.
const decode = (codes, language) => codes.split(' ').map((code) => M.decodeSymbol(code, language)).join('');
check('decode en', decode('.-- .- ...- .', 'en'), 'WAVE');
check('decode ru', decode('.-- .- ...- .', 'ru'), 'ВАЖЕ');
check('ru letters over punctuation', decode('.-.- ..-- ---- --.-- ..-..', 'ru'), 'ЯЮШЪЭ');
check('en has no Я', M.decodeSymbol('.-.-', 'en'), M.UNKNOWN);
check('ru full stop', M.decodeSymbol('......', 'ru'), '.');
check('digits in ru', decode('.---- ..--- ...--', 'ru'), '123');
check('round trip en', [...'HELLO123?'].map((c) => M.decodeSymbol(M.codeOf(c), 'en')).join(''), 'HELLO123?');
check('round trip ru', [...'ПРИВЕТ'].map((c) => M.decodeSymbol(M.codeOf(c), 'ru')).join(''), 'ПРИВЕТ');
check('languages', M.MORSE_LANGUAGES, ['en', 'ru']);

// Timing: PARIS at 12 WPM is 50 units of 100 ms, the last 7 being the word gap that follows.
check('dot at 20 wpm', M.dotMs(20), 60);
const units = (text) => M.timeline(text, 12).map(({ on, ms }) => (on ? '+' : '-') + Math.round(ms / 100));
check('E T', units('E T'), ['+1', '-7', '+3']);
check('A', units('A'), ['+1', '-1', '+3']);
check('AB', units('AB'), ['+1', '-1', '+3', '-3', '+3', '-1', '+1', '-1', '+1', '-1', '+1']);
check('PARIS is 43 units without the word gap', M.timeline('PARIS', 12).reduce((s, { ms }) => s + ms, 0), 4300);
check('index of the character sent', M.timeline('A B', 12).map(({ index }) => index), [0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2]);
check('leading and trailing space', units(' E '), ['+1']);

done('morse');
