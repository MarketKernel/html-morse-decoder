/**
 * The built page in headless Chrome, end to end: the generator sends two
 * transmissions at once — English at 700 Hz, Russian at 1100 Hz — straight
 * into the decoder; clicks on the waterfall tune decoder A to one and
 * Shift-click tunes B to the other; both must read their text. Then the
 * alphabet switch, the interface in Russian, the microphone (Chrome's fake
 * one), the phone layout and the dark theme. Then the PWA of build/pages/:
 * offline from its service worker, and an update from a new deploy.
 *
 * Needs `npm run build` first and a local Chrome (or `CHROME=/path/to/chrome`).
 * `--shots DIR` also saves screenshots into DIR.
 */
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { launch, sleep } from '../tools/chrome.mjs';
import { checker, root } from '../tools/load.mjs';

const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
const { check, done } = checker();

const html = await readFile(join(root, 'build', 'morse-decoder.html'));
const PAGES = join(root, 'build', 'pages');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
// Set, the server drops every request for build/pages/: the network is gone.
let pagesDown = false;
// Set, the server hands out a service worker of this version: a new deploy, as the page sees it.
let nextVersion = null;
// /pages/… is build/pages/, any other path the single file.
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (!path.startsWith('/pages/')) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
    return;
  }
  if (pagesDown) return req.socket.destroy();
  const name = path.endsWith('/') ? 'index.html' : basename(path);
  try {
    let body = await readFile(join(PAGES, name));
    if (name === 'sw.js' && nextVersion) body = body.toString().replace(/const VERSION = '[^']*'/, `const VERSION = '${nextVersion}'`);
    res.setHeader('content-type', TYPES[extname(name)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await launch({
  flags: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
if (!browser) {
  console.log('No Chrome found — set CHROME=/path/to/chrome. Skipping the browser test.');
  server.close();
  process.exit(0);
}
const { send, evaluate, until, click, clickAt, errors } = browser;
const shot = async (name) => {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await browser.shot(join(SHOTS, `${name}.png`));
};

const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const decoded = (slot) => `(document.querySelector('.decoder[data-slot="${slot}"] .decoder-out')?.textContent ?? '')`;
/** Sets a field the way typing does: the value, then the event the page listens to. */
const setField = (selector, value, event = 'input') =>
  evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event(${JSON.stringify(event)})); })()`);
const setCheck = (selector, value) =>
  evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (n.checked !== ${value}) n.click(); })()`);
/** Clicks the waterfall where `hz` is, in the default 200–1400 Hz range. */
const clickHz = async (hz, options) => {
  const [x, y] = await evaluate(`(() => {
    const n = document.querySelector('#waterfall');
    n.scrollIntoView({ block: 'center' });
    const r = n.getBoundingClientRect();
    return [r.left + r.width * (${hz} - 200) / 1200, r.top + r.height / 2];
  })()`);
  await clickAt(x, y, options);
};

try {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('morse-decoder', JSON.stringify({ language: 'en', theme: 'light', generator: { hear: false, feed: true, loop: true } }));`,
  });
  await send('Page.navigate', { url });
  await until(`document.readyState === 'complete'`);

  // The page as it opens
  check('title', await evaluate('document.title'), 'Morse Decoder');
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  check('version shown, as in package.json', (await text('#version')).split('+')[0], version);
  check('no updates in the single file', await evaluate(`document.querySelector('#update').hidden && document.querySelector('#update-ready').hidden`), true);
  check('two decoder cards', await evaluate(`document.querySelectorAll('.decoder').length`), 2);
  check('scope waits for sound', await evaluate(`!document.querySelector('#scope-empty').hidden`), true);
  check('decoder A asks for a click', await text('.decoder[data-slot="0"] .decoder-empty'), 'Click a signal on the waterfall to decode it.');
  check('the code of the text', await evaluate(`[...document.querySelectorAll('#gen-code .gen-char i')].slice(0, 2).map((n) => n.textContent)`), ['−·−·', '−−·−']);
  await shot('1-start');

  // Signal 1: English, 700 Hz, 20 WPM, into the decoder
  await setField('#gen-text', 'CQ TEST 73');
  await setField('#gen-wpm', '20');
  await setField('#gen-tone', '700', 'change');
  await click('#gen-play');
  check('waterfall running', await until(`document.querySelector('#scope-empty').hidden`, 5000), true);
  check('one transmission', await text('#gen-status'), '1 transmission on the air');
  await sleep(600);
  await clickHz(700);
  check('decoder A tuned near 700 Hz', await until(`Math.abs(Number(document.querySelector('.decoder[data-slot="0"] .decoder-freq-input').value) - 700) <= 12`, 3000), true);
  check('marker A shown', await evaluate(`document.querySelectorAll('.marker[data-slot="0"]').length`), 1);
  const gotA = await until(`${decoded(0)}.includes('CQ TEST 73')`, 30000);
  check('decoder A reads the English text', gotA, true);
  if (!gotA) console.error(`  decoder A: ${JSON.stringify(await evaluate(decoded(0)))}`);
  check('decoder A learned the speed', await text('.decoder[data-slot="0"] .decoder-wpm'), '20 WPM');

  // Signal 2, at the same time: Russian, 1100 Hz, 15 WPM; Shift-click tunes decoder B
  await setField('#gen-text', 'ПРИВЕТ МИР');
  await setField('#gen-wpm', '15');
  await setField('#gen-tone', '1100', 'change');
  await click('#gen-play');
  check('two transmissions', await text('#gen-status'), '2 transmissions on the air');
  await sleep(600);
  await clickHz(1100, { modifiers: 8 });
  check('decoder B tuned near 1100 Hz', await until(`Math.abs(Number(document.querySelector('.decoder[data-slot="1"] .decoder-freq-input').value) - 1100) <= 12`, 3000), true);
  await setField('.decoder[data-slot="1"] .decoder-lang', 'ru', 'change');
  const gotB = await until(`${decoded(1)}.includes('ПРИВЕТ МИР')`, 30000);
  check('decoder B reads the Russian text', gotB, true);
  if (!gotB) console.error(`  decoder B: ${JSON.stringify(await evaluate(decoded(1)))}`);
  check('decoder A still reads its own', await until(`${decoded(0)}.split('CQ TEST 73').length > 2`, 15000), true);
  check('decoder A has no Cyrillic', /[А-Я]/.test(await evaluate(decoded(0))), false);
  check('two markers', await evaluate(`document.querySelectorAll('.marker').length`), 2);
  await shot('2-two-signals');

  // The same codes in the other alphabet: spelled again at once
  await setField('.decoder[data-slot="1"] .decoder-lang', 'en', 'change');
  check('B in Latin', await until(`${decoded(1)}.includes('PRIWET MIR')`, 2000), true);
  await setField('.decoder[data-slot="1"] .decoder-lang', 'ru', 'change');

  // Stop
  await click('#gen-stop');
  check('stopped', await until(`document.querySelector('#gen-status').textContent === ''`, 3000), true);
  check('stop disabled', await evaluate(`document.querySelector('#gen-stop').disabled`), true);

  // Clear and off
  await click('.decoder[data-slot="1"] .decoder-clear');
  check('B cleared', await until(`${decoded(1)} === ''`, 1000), true);
  await click('.decoder[data-slot="1"] .decoder-off');
  check('B off', await until(`document.querySelectorAll('.marker').length === 1`, 1000), true);

  // The interface in Russian
  await setField('#ui-language', 'ru', 'change');
  check('heading in russian', await text('#receiver-title'), 'Приёмник');
  check('mic button in russian', await text('#mic-label'), 'Включить микрофон');
  check('html lang', await evaluate('document.documentElement.lang'), 'ru');
  check('cards translated', await text('.decoder[data-slot="1"] .decoder-empty'), 'Для второго сигнала: Shift+клик по нему или выберите B выше и кликните.');
  check('settings remembered', await until(`JSON.parse(localStorage.getItem('morse-decoder')).language === 'ru'`, 2000), true);
  await setField('#ui-language', 'en', 'change');

  // The microphone: Chrome's fake device
  await click('#mic');
  check('microphone on', await until(`document.querySelector('#mic').getAttribute('aria-pressed') === 'true'`, 5000), true);
  check('mic button says stop', await text('#mic-label'), 'Stop microphone');
  await click('#mic');
  check('microphone off', await until(`document.querySelector('#mic').getAttribute('aria-pressed') === 'false'`, 2000), true);

  // Dark theme
  await setField('#theme', 'dark', 'change');
  check('dark theme', await evaluate('document.documentElement.dataset.theme'), 'dark');
  await shot('3-dark');
  await setField('#theme', 'light', 'change');

  // A phone's screen: nothing wider than it
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  check('phone: no sideways scroll', await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  await shot('4-phone');
  await send('Emulation.clearDeviceMetricsOverride');
  check('no errors on the page', errors, []);

  // The PWA: its CSP lets in the manifest and the service worker, which keeps it offline
  const reload = async () => {
    await evaluate(`window.__beforeReload = true`);
    await send('Page.reload');
    return until(`!window.__beforeReload && document.readyState === 'complete'`, 15000);
  };
  const updateLine = `(document.querySelector('#update')?.textContent ?? '')`;
  const workerVersion = () =>
    evaluate(`new Promise((resolve) => { const c = new MessageChannel(); c.port1.onmessage = (e) => resolve(e.data); navigator.serviceWorker.controller.postMessage('version', [c.port2]); })`);
  await send('Page.navigate', { url: `${url}pages/` });
  check('pwa: service worker in control', await until(`navigator.serviceWorker.controller !== null`), true);
  check('pwa: manifest parsed', (await send('Page.getAppManifest')).errors, []);
  check('pwa: installable', (await send('Page.getInstallabilityErrors')).installabilityErrors, []);
  check('pwa: offers a check', await until(`document.querySelector('#update button')?.textContent === 'Check for updates'`), true);
  pagesDown = true;
  check('pwa: offline', await reload(), true);
  check('pwa: offline, the page is whole', await evaluate(`document.querySelectorAll('.decoder').length`), 2);
  await click('#gen-play');
  check('pwa: offline, the generator plays', await until(`document.querySelector('#scope-empty').hidden`, 5000), true);
  await click('#gen-stop');

  // Updates: a new deploy installs beside the running version and waits for Update
  const running = await text('#version');
  check('pwa: the worker knows its version', await workerVersion(), running);
  await click('#update button');
  check('pwa: no server, no check', await until(`${updateLine}.startsWith('No connection: could not check for updates.')`), true);
  pagesDown = false;
  await click('#update button');
  check('pwa: nothing new', await until(`${updateLine} === 'This is the latest version.'`), true);
  check('pwa: no update button', await evaluate(`document.querySelector('#update-ready').hidden`), true);
  nextVersion = '9.9.9';
  // The browser looks for a new worker on every launch of the app
  await reload();
  check('pwa: a new version ready', await until(`${updateLine} === 'Version 9.9.9 is ready. Update'`, 15000), true);
  check('pwa: and in the top bar', await text('#update-ready'), 'Update to version 9.9.9');
  check('pwa: the old worker still serves', await workerVersion(), running);
  await shot('5-update-ready');
  await evaluate(`window.__beforeReload = true`);
  await click('#update-ready');
  check('pwa: update reloads the page', await until(`!window.__beforeReload && document.readyState === 'complete'`, 15000), true);
  check('pwa: the new worker serves', await workerVersion(), '9.9.9');
  check('pwa: the old cache gone', (await evaluate(`caches.keys()`)).length, 1);
  check('pwa: nothing waits now', await until(`${updateLine} === 'Check for updates'`), true);
  check('pwa: the button gone', await evaluate(`document.querySelector('#update-ready').hidden`), true);
  pagesDown = true;
  check('pwa: offline after the update', await reload(), true);
  pagesDown = false;
  // The page served is the same, only the worker changed: what the app ran before is set back to see the note
  await evaluate(`localStorage.setItem('morse-decoder-version', '0.0.1')`);
  await reload();
  check('pwa: "updated" said once', await until(`!document.querySelector('#toast').hidden && document.querySelector('#toast').textContent === ${JSON.stringify(`Updated to version ${running}.`)}`), true);
  check('pwa: and remembered', await evaluate(`localStorage.getItem('morse-decoder-version')`), running);
} finally {
  await browser.close();
  server.close();
}

done('app');
