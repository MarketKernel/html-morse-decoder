# Morse decoder

A Morse code decoder and generator in **one HTML file**. Open it from the disk, allow the
microphone, click a signal on the waterfall — and read it. Nothing is sent anywhere: the sound
is processed in the page, which is not allowed any network access at all.

- **Spectrum and waterfall** of what the microphone hears.
- **Two decoders at once**: click a signal for decoder A, Shift-click (or right-click) another
  for B. A click snaps to the nearest peak.
- **Latin and Cyrillic** Morse. The same codes mean different letters in the two alphabets;
  each decoder keeps the codes it heard, so switching its alphabet re-spells the whole text.
- **Speed is learned** from the signal, 5–50 WPM, no setting needed.
- **Generator**: type a text, it beeps — through the speakers, straight into the decoder, or
  both. Every Play starts one more transmission, so two signals at once are two clicks away.
  Test noise shows how the decoder copes with weak signals.
- Interface in English and Russian, light and dark theme, works on a phone.
- **Installable**: the online version is a PWA that keeps working without a network.

## Get it

- **The file**: download `morse-decoder-<version>.html` from
  [Releases](https://github.com/MarketKernel/html-morse-decoder/releases) and open it.
- **Online**: [marketkernel.github.io/html-morse-decoder](https://marketkernel.github.io/html-morse-decoder/).
  Install it from the browser (Chrome and Edge: the install icon in the address bar; Safari on
  iPhone: Share → Add to Home Screen) and it opens in its own window, offline too. A new
  version shows **Update to version …** at the top; until then the old one keeps running.

## How to use

1. Open `morse-decoder.html` in Chrome, Edge, Firefox or Safari (from the disk, or from any
   https:// address — the microphone needs one of the two).
2. **Start microphone** and allow it. Or skip the microphone: in **Generator**, leave *Feed
   straight into the decoder* on and press **Play**.
3. Click the signal's trace on the waterfall. Decoder A tunes to it and starts writing.
4. For a second signal, Shift-click it (or pick **B** under the waterfall and click).
5. Pick **Cyrillic (RU)** in a decoder for Russian text.

**Filter** sets the decoders' passband: 50 Hz hears weaker signals, 200 Hz follows faster ones
and drift. **Squelch** is how far above the noise a signal must stand to be decoded: lower it
for weak signals, raise it if noise turns into stray letters.

## How it works

- Spectrum: 4096-point FFT under a Hann window, a new row every 1024 samples.
- Each decoder mixes its frequency down to zero and low-passes it (fourth-order Butterworth),
  so a signal a few hundred hertz away does not reach it. The level is read every 5 ms.
- Key down/up: the noise is the 10th percentile of the last two seconds of levels, the signal
  a slowly sinking peak; the threshold is halfway between them. Decisions lag half a second
  behind, so a decoder tuned to a station already sending has seen the gaps first.
- Timing: dots and dashes are found as two clusters (2-means over the recent marks); letters
  end after two dots of silence, words after five. Until the speed is known, what was heard is
  kept and decoded again once it is.

## Build

Node 22 or newer.

```sh
npm install
npm run build        # -> build/morse-decoder.html
npm run check        # typecheck, unit tests, build, test in headless Chrome
npm run watch        # rebuild on every change
npm run shots        # screenshots into shots/
npm run i18n         # strings missing from or unused in the Russian dictionary
npm run icons        # assets/pwa/*.png from assets/icon.svg, after changing the icon
```

`build/` gets two things: `morse-decoder.html`, the single file, and `pages/`, the same page
as a PWA — a manifest, PNG icons and a service worker (`src/pwa/sw.js`) that keeps it offline.
The PWA's copy of the page lets in only its own origin's manifest, worker and icons;
`connect-src` stays `'none'`.

The unit tests feed the decoders synthesized signals — two at once, both alphabets, 5 to
50 WPM, seeded noise — and check the text letter for letter. `tests/app.mjs` does the same
through the built page in Chrome: the generator plays into the decoder, the test clicks the
waterfall and waits for the text. Then it opens `build/pages/`: the worker in control, the
manifest installable, the page offline, and an update from a new deploy.

## Versions and releases

The version lives in `package.json` only. A build of the commit tagged `v<version>` shows it as
it is; any other build adds the commit (`0.1.0+1a2b3c4`), so a page built from `main` is not
taken for a release.

To release: `npm version minor && git push --follow-tags`. The tag starts
`.github/workflows/release.yml`: it checks that the tag is `package.json`'s version, runs the
tests, and attaches `morse-decoder-<tag>.html` and `SHA256SUMS.txt` to a GitHub release.

## GitHub Pages

Every push to `main` runs `.github/workflows/pages.yml`: the same checks, then `build/pages/` is
deployed. Once, in the repository: Settings → Pages → Source: **GitHub Actions**. Every path in
the PWA is relative, so it works under `/<repo>/`. The service worker's cache is named after the
version and a hash of the page: each deploy is a new worker, which waits until the user presses
Update or closes every window of the app.

## Layout

| Path | What |
| --- | --- |
| `build.mjs` | Bundles everything into one HTML file, refuses external references |
| `src/core/morse.ts` | Alphabets, encoding, the key's timing |
| `src/core/fft.ts` | The spectrum |
| `src/core/decoder.ts` | Demodulator, key detector, timing decoder |
| `src/core/receiver.ts` | Samples in, spectrum frames and decoders out |
| `src/core/synth.ts` | Morse as samples, for the tests |
| `src/core/settings.ts` | Settings in localStorage, each field checked |
| `src/core/i18n.ts`, `src/locales/ru.json` | Interface languages |
| `src/app/` | The page: template, styles, audio graph, scope, decoder cards, generator |
| `src/app/update.ts` | Updates of the installed app: finds a waiting worker, lets it in on Update |
| `src/pwa/sw.js` | The PWA's service worker |
| `assets/` | The icon; `pwa/` — its PNGs, made by `npm run icons` |
| `tests/`, `tools/` | Unit tests, the Chrome test (the page and the PWA), helpers |
| `.github/workflows/` | `test.yml` on every push, `pages.yml` deploys the PWA, `release.yml` on a `v*` tag |

## Limitations

- Prosigns (`<AR>`, `<SK>` …) come out as the characters their codes share, or `*`.
- A decoder tuned in the first moment of a very slow (5 WPM) dash may read it as a dot.
- The microphone gets the raw signal (no echo cancelling or noise suppression), so playing the
  generator aloud near the microphone is heard as well — on purpose.
