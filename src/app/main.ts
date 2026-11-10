/**
 * The page: settings, the receiver with its scope and two decoders, the
 * generator. The sound starts on the first click that needs it — the
 * microphone, Play, or a click on the scope — as browsers require.
 */
import { detectLanguage, LANGUAGES, type Language, setLanguage, t, translatePage } from '../core/i18n';
import type { MorseLanguage } from '../core/morse';
import { Receiver } from '../core/receiver';
import { BANDWIDTHS, type Bandwidth, parseSettings, type Settings, SPANS, type Span, SQUELCH, STORAGE_KEY, type Theme } from '../core/settings';
import { AudioEngine, type MicError } from './audio';
import { DecoderView } from './decoders';
import { Generator } from './generator';
import { Scope } from './scope';
import { byId, fillSelect, toast } from './ui';
import { applyUpdate, canUpdate, checkForUpdate, justUpdated, startUpdates, updateState } from './update';

const SLOTS = 2;

function load(): Settings {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  return parseSettings(stored, detectLanguage() === 'ru' ? 'ru' : 'en');
}

const settings = load();
let saveTimer = 0;
function save(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Private mode or storage switched off: the settings last until the page closes.
    }
  }, 300);
}

/* ---------- Language and theme ---------- */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(): void {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  scope.readColors();
}

function applyLanguage(): void {
  setLanguage(settings.language === 'system' ? detectLanguage() : settings.language);
  translatePage();
  fillSelect(
    byId<HTMLSelectElement>('ui-language'),
    [['system', t('settings', 'As in the system')], ...(Object.entries(LANGUAGES) as [string, string][])],
    settings.language,
  );
  fillSelect(
    byId<HTMLSelectElement>('theme'),
    [
      ['system', t('settings', 'As in the system')],
      ['light', t('settings', 'Light')],
      ['dark', t('settings', 'Dark')],
    ],
    settings.theme,
  );
  fillSelect(
    byId<HTMLSelectElement>('bandwidth'),
    BANDWIDTHS.map((b) => [String(b), t('receiver', '{hz} Hz', { hz: b })]),
    String(settings.bandwidth),
  );
  fillSelect(
    byId<HTMLSelectElement>('span'),
    [
      ['cw', t('receiver', '200–1400 Hz')],
      ['voice', t('receiver', '0–3 kHz')],
      ['wide', t('receiver', '0–6 kHz')],
    ],
    settings.span,
  );
  renderSquelch();
  renderMic();
  for (const view of views) view.retranslate();
  generator.retranslate();
  renderUpdate();
  refresh();
}

/* ---------- Sound ---------- */

let engine: AudioEngine | null = null;
let receiver: Receiver | null = null;

async function getEngine(): Promise<AudioEngine> {
  if (!engine) {
    engine = new AudioEngine((samples) => receiver?.push(samples));
    receiver = new Receiver({ sampleRate: engine.sampleRate, bandwidth: settings.bandwidth, squelch: settings.squelch });
    scope.attach(receiver);
    if (settings.generator.noise > 0) engine.setNoise(settings.generator.noise);
  }
  await engine.resume();
  return engine;
}

/* ---------- Receiver ---------- */

let activeSlot = 0;

const scope = new Scope(SPANS[settings.span], (frequency, other) => {
  const slot = other ? (activeSlot + 1) % SLOTS : activeSlot;
  void tune(slot, frequency, true);
});

async function tune(slot: number, frequency: number, snap: boolean): Promise<void> {
  await getEngine();
  if (!receiver) return;
  // A click lands near a signal, rarely on it: the strongest peak within the passband wins.
  const target = snap ? receiver.snap(frequency, Math.max(settings.bandwidth, 3 * receiver.binHz)) : frequency;
  receiver.tune(slot, Math.round(target));
  refresh();
}

function renderMic(): void {
  const on = engine?.micOn ?? false;
  const button = byId('mic');
  button.setAttribute('aria-pressed', String(on));
  byId('mic-label').textContent = on ? t('receiver', 'Stop microphone') : t('receiver', 'Start microphone');
}

const MIC_ERRORS: Record<MicError, () => string> = {
  denied: () => t('receiver', 'The browser was not allowed to use the microphone. Allow it in the site settings and try again.'),
  missing: () => t('receiver', 'No microphone found'),
  insecure: () => t('receiver', 'The microphone works only on https:// or in a file opened from the disk'),
  failed: () => t('receiver', 'The microphone could not be started'),
};

byId('mic').addEventListener('click', async () => {
  const sound = await getEngine();
  if (sound.micOn) sound.stopMic();
  else {
    const error = await sound.startMic();
    if (error) toast(MIC_ERRORS[error](), 'error');
  }
  renderMic();
});

const bandwidthSelect = byId<HTMLSelectElement>('bandwidth');
bandwidthSelect.addEventListener('change', () => {
  settings.bandwidth = (BANDWIDTHS.find((b) => String(b) === bandwidthSelect.value) ?? 100) as Bandwidth;
  receiver?.configure({ bandwidth: settings.bandwidth });
  save();
  refresh();
});

const spanSelect = byId<HTMLSelectElement>('span');
spanSelect.addEventListener('change', () => {
  settings.span = (Object.hasOwn(SPANS, spanSelect.value) ? spanSelect.value : 'cw') as Span;
  scope.setSpan(SPANS[settings.span]);
  save();
});

const squelch = byId<HTMLInputElement>('squelch');
squelch.min = String(SQUELCH.min);
squelch.max = String(SQUELCH.max);
squelch.value = String(settings.squelch);
function renderSquelch(): void {
  byId<HTMLOutputElement>('squelch-value').value = t('decoder', '{db} dB', { db: settings.squelch });
}
squelch.addEventListener('input', () => {
  settings.squelch = Number(squelch.value);
  receiver?.configure({ squelch: settings.squelch });
  renderSquelch();
  save();
});

const picks = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-pick]'));
function activate(slot: number): void {
  activeSlot = slot;
  for (const pick of picks) pick.setAttribute('aria-checked', String(pick.dataset.pick === String(slot)));
  refresh();
}
for (const pick of picks) pick.addEventListener('click', () => activate(Number(pick.dataset.pick)));

const views = Array.from({ length: SLOTS }, (_, slot) =>
  new DecoderView(slot, byId('decoders'), settings.decoders[slot] ?? 'en', {
    onLanguage(slot: number, language: MorseLanguage) {
      settings.decoders[slot] = language;
      save();
      refresh();
    },
    onFrequency(slot: number, frequency: number) {
      void tune(slot, frequency, false);
    },
    onOff(slot: number) {
      receiver?.off(slot);
      refresh();
    },
    onActivate(slot: number) {
      if (slot !== activeSlot) activate(slot);
    },
    onClear(slot: number) {
      receiver?.channels[slot]?.decoder.clear();
      refresh();
    },
  }),
);

/** The decoders' cards and the markers, now. */
function refresh(): void {
  const channels = receiver?.channels ?? [];
  views.forEach((view, slot) => view.update(channels[slot] ?? null, settings.decoders[slot] ?? 'en', slot === activeSlot));
  scope.setMarkers(
    channels.flatMap((channel, slot) => (channel ? [{ slot, frequency: channel.frequency, bandwidth: settings.bandwidth }] : [])),
  );
}

/* ---------- Generator ---------- */

const generator: Generator = new Generator(settings.generator, getEngine, save);

/* ---------- Settings ---------- */

const languageSelect = byId<HTMLSelectElement>('ui-language');
languageSelect.addEventListener('change', () => {
  const value = languageSelect.value;
  settings.language = value === 'system' || Object.hasOwn(LANGUAGES, value) ? (value as 'system' | Language) : 'system';
  save();
  applyLanguage();
});

const themeSelect = byId<HTMLSelectElement>('theme');
themeSelect.addEventListener('change', () => {
  const value = themeSelect.value;
  settings.theme = (['system', 'light', 'dark'].includes(value) ? value : 'system') as Theme;
  save();
  applyTheme();
});
darkQuery.addEventListener('change', applyTheme);

/* ---------- Updates (the installed app only) ---------- */

function linkButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link-button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

/** The footer's line after the version, and the top bar's button once a new version waits. */
function renderUpdate(): void {
  const state = updateState();
  const ready = byId<HTMLButtonElement>('update-ready');
  ready.hidden = state.kind !== 'ready';
  if (state.kind === 'ready') {
    ready.textContent = state.version ? t('update', 'Update to version {version}', { version: state.version }) : t('update', 'Update');
  }
  const line = byId('update');
  line.hidden = byId('update-dot').hidden = !canUpdate();
  if (line.hidden) return;
  const check = () => linkButton(t('update', 'Check for updates'), () => void checkForUpdate());
  let note: (Node | string)[];
  switch (state.kind) {
    case 'idle':
      note = [check()];
      break;
    case 'checking':
      note = [t('update', 'Checking for updates…')];
      break;
    case 'latest':
      note = [t('update', 'This is the latest version.')];
      break;
    case 'offline':
      note = [t('update', 'No connection: could not check for updates.'), ' ', check()];
      break;
    case 'ready':
      note = [
        state.version ? t('update', 'Version {version} is ready.', { version: state.version }) : t('update', 'A new version is ready.'),
        ' ',
        linkButton(t('update', 'Update'), applyUpdate),
      ];
      break;
  }
  line.replaceChildren(...note);
}
byId('update-ready').addEventListener('click', applyUpdate);

byId('version').textContent = __APP_VERSION__;
applyTheme();
applyLanguage();
startUpdates(renderUpdate);
if (justUpdated()) toast(t('update', 'Updated to version {version}.', { version: __APP_VERSION__ }));

/* ---------- The loop ---------- */

let lastRefresh = 0;
function frame(now: number): void {
  scope.draw();
  generator.tick();
  // The cards change slower than the eye: ten times a second is plenty, and cheaper.
  if (now - lastRefresh > 100) {
    lastRefresh = now;
    refresh();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
