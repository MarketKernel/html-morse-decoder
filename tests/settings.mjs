/** Settings read back from whatever localStorage holds. */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const S = await load('core/settings');

check('nothing stored', S.parseSettings(null), S.defaults());
check('broken JSON', S.parseSettings('{oops'), S.defaults());
check('not an object', S.parseSettings('[1,2]'), S.defaults());
check('russian defaults', S.parseSettings(null, 'ru').decoders, ['ru', 'ru']);

const saved = { ...S.defaults(), language: 'ru', theme: 'dark', bandwidth: 50, span: 'wide', squelch: 20, decoders: ['ru', 'en'] };
check('round trip', S.parseSettings(JSON.stringify(saved)), saved);

const bad = S.parseSettings(JSON.stringify({
  language: 'xx', theme: 'blue', bandwidth: 75, span: 'huge', squelch: 99, decoders: ['de', 'ru'],
  generator: { text: 42, wpm: 1, tone: 99999, volume: -1, hear: 'yes', feed: false, loop: true, noise: 2 },
}));
check('unknown language', bad.language, 'system');
check('unknown theme', bad.theme, 'system');
check('unknown bandwidth', bad.bandwidth, 100);
check('unknown span', bad.span, 'cw');
check('squelch clamped', bad.squelch, S.SQUELCH.max);
check('decoders field by field', bad.decoders, ['en', 'ru']);
check('text not a string', bad.generator.text, S.defaults().generator.text);
check('wpm clamped', bad.generator.wpm, S.WPM.min);
check('tone clamped', bad.generator.tone, S.TONE.max);
check('volume clamped', bad.generator.volume, 0);
check('hear not a boolean', bad.generator.hear, true);
check('feed kept', bad.generator.feed, false);
check('loop kept', bad.generator.loop, true);
check('noise clamped', bad.generator.noise, 1);
check('text limited', S.parseSettings(JSON.stringify({ generator: { text: 'x'.repeat(5000) } })).generator.text.length, S.TEXT_LIMIT);

done('settings');
