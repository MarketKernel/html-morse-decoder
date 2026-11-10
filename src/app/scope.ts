/**
 * The spectrum over the waterfall, and the decoders' markers on them.
 *
 * The receiver hands over a spectrum some 47 times a second; each becomes a
 * row at the top of the waterfall, which scrolls down. The spectrum line on
 * top is the receiver's average, so a keyed signal stands as a steady peak.
 * Levels are shown against the noise floor, measured on every row, so the
 * picture needs no gain knob: the noise is dark blue, a signal bright.
 */
import { t } from '../core/i18n';
import type { Receiver } from '../core/receiver';
import { byId } from './ui';

export interface Marker {
  slot: number;
  frequency: number;
  bandwidth: number;
}

/** dB above the floor that reach the top of the palette. */
const RANGE_DB = 42;
/** The deepest the floor goes under the strongest signal. */
const DEPTH_DB = 50;
/** Rows waiting to be drawn, at most: a hidden tab does not draw, and a second of them is plenty. */
const QUEUE = 60;
const SLOT_NAMES = ['A', 'B'];

/** The waterfall's palette: black, through blue and cyan, to yellow and white. */
function palette(): Uint8ClampedArray {
  const stops: [number, number, number, number][] = [
    [0, 4, 8, 22],
    [0.25, 12, 40, 110],
    [0.5, 30, 140, 210],
    [0.7, 110, 225, 200],
    [0.86, 255, 222, 90],
    [1, 255, 255, 255],
  ];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    const upper = stops.findIndex(([at]) => at >= v);
    const [a0, ...from] = stops[Math.max(0, upper - 1)] as [number, number, number, number];
    const [a1, ...to] = stops[Math.max(0, upper)] as [number, number, number, number];
    const k = a1 === a0 ? 0 : (v - a0) / (a1 - a0);
    for (let c = 0; c < 3; c++) lut[i * 4 + c] = (from[c] as number) + ((to[c] as number) - (from[c] as number)) * k;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

export class Scope {
  private readonly root = byId('scope');
  private readonly spectrum = byId<HTMLCanvasElement>('spectrum');
  private readonly waterfall = byId<HTMLCanvasElement>('waterfall');
  private readonly markersBox = byId('markers');
  private readonly cursor = byId('cursor');
  private readonly cursorLabel = byId('cursor-label');
  private readonly empty = byId('scope-empty');
  private readonly lut = palette();
  private receiver: Receiver | null = null;
  private span: readonly [number, number];
  private queue: Float32Array[] = [];
  private floor = Number.NaN;
  private noiseFloor = Number.NaN;
  /** The strongest level of recent rows, sinking 0.3 dB a row (some 14 dB a second). */
  private strongest = Number.NaN;
  /** Per pixel of width: the bins it covers, or a fractional bin to interpolate at. */
  private from = new Int32Array(0);
  private to = new Int32Array(0);
  private at = new Float32Array(0);
  private pixels = new Float32Array(0);
  private sorted = new Float32Array(0);
  private row: ImageData | null = null;
  private dirty = true;
  private markers: Marker[] = [];
  private colors = { grid: '', text: '', line: '' };

  constructor(span: readonly [number, number], onTune: (frequency: number, other: boolean) => void) {
    this.span = span;
    new ResizeObserver(() => this.resize()).observe(this.root);
    this.root.addEventListener('pointermove', (event) => this.hover(event));
    this.root.addEventListener('pointerleave', () => {
      this.cursor.hidden = true;
    });
    this.root.addEventListener('click', (event) => onTune(this.frequencyAt(event.clientX), event.shiftKey));
    this.root.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      onTune(this.frequencyAt(event.clientX), true);
    });
    this.readColors();
  }

  attach(receiver: Receiver): void {
    this.receiver = receiver;
    receiver.onFrame = (levels) => {
      this.queue.push(levels.slice());
      if (this.queue.length > QUEUE) this.queue.shift();
    };
    this.mapPixels();
  }

  setSpan(span: readonly [number, number]): void {
    this.span = span;
    this.mapPixels();
    this.clearWaterfall();
    this.dirty = true;
    this.placeMarkers();
  }

  setMarkers(markers: Marker[]): void {
    const same =
      markers.length === this.markers.length &&
      markers.every((m, i) => {
        const o = this.markers[i];
        return o && o.slot === m.slot && Math.abs(o.frequency - m.frequency) < 0.5 && o.bandwidth === m.bandwidth;
      });
    if (same) return;
    this.markers = markers;
    this.placeMarkers();
  }

  /** After a theme change: the spectrum's grid and labels follow the page's colours. */
  readColors(): void {
    const style = getComputedStyle(document.documentElement);
    this.colors = {
      grid: style.getPropertyValue('--scope-grid').trim(),
      text: style.getPropertyValue('--scope-text').trim(),
      line: style.getPropertyValue('--scope-line').trim(),
    };
    this.dirty = true;
  }

  /** The frequency under a point of the screen. */
  frequencyAt(clientX: number): number {
    const box = this.root.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    const [lo, hi] = this.span;
    return lo + x * (hi - lo);
  }

  /** Draws what came in since the last frame; called from requestAnimationFrame. */
  draw(): void {
    if (!this.receiver) return;
    const rows = this.queue;
    this.queue = [];
    if (rows.length) {
      this.empty.hidden = true;
      this.drawRows(rows);
      this.dirty = true;
    }
    if (this.dirty) {
      this.drawSpectrum();
      this.dirty = false;
    }
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const canvas of [this.spectrum, this.waterfall]) {
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }
    this.mapPixels();
    this.clearWaterfall();
    this.dirty = true;
  }

  private clearWaterfall(): void {
    const ctx = this.waterfall.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = 'rgb(4, 8, 22)';
    ctx.fillRect(0, 0, this.waterfall.width, this.waterfall.height);
  }

  private mapPixels(): void {
    const width = this.waterfall.width;
    const binHz = this.receiver?.binHz ?? 1;
    const bins = (this.receiver?.fftSize ?? 2) / 2;
    const [lo, hi] = this.span;
    const hz = (hi - lo) / width;
    this.from = new Int32Array(width);
    this.to = new Int32Array(width);
    this.at = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const f0 = lo + x * hz;
      const f1 = f0 + hz;
      this.from[x] = Math.min(bins - 1, Math.max(0, Math.floor(f0 / binHz)));
      this.to[x] = Math.min(bins - 1, Math.max(0, Math.floor(f1 / binHz)));
      this.at[x] = Math.min(bins - 1.001, Math.max(0, (f0 + hz / 2) / binHz));
    }
    this.pixels = new Float32Array(width);
    this.sorted = new Float32Array(width);
    this.row = null;
  }

  /** One spectrum as levels per pixel: the strongest bin under it, or between two bins. */
  private sample(levels: Float32Array, out: Float32Array): void {
    for (let x = 0; x < out.length; x++) {
      const from = this.from[x] as number;
      const to = this.to[x] as number;
      if (to > from) {
        let max = -Infinity;
        for (let b = from; b <= to; b++) max = Math.max(max, levels[b] as number);
        out[x] = max;
      } else {
        const at = this.at[x] as number;
        const b = Math.floor(at);
        const k = at - b;
        out[x] = (levels[b] as number) * (1 - k) + (levels[b + 1] as number) * k;
      }
    }
  }

  private drawRows(rows: Float32Array[]): void {
    const ctx = this.waterfall.getContext('2d');
    if (!ctx) return;
    const { width, height } = this.waterfall;
    if (!this.row || this.row.width !== width) this.row = ctx.createImageData(width, 1);
    const n = Math.min(rows.length, height);
    // Down by n rows, then the newest at the top.
    ctx.drawImage(this.waterfall, 0, 0, width, height - n, 0, n, width, height - n);
    rows.slice(-n).forEach((levels, i) => {
      this.sample(levels, this.pixels);
      this.updateFloor();
      const data = (this.row as ImageData).data;
      for (let x = 0; x < width; x++) {
        const v = ((this.pixels[x] as number) - this.floor) / RANGE_DB;
        const index = Math.max(0, Math.min(255, Math.round(v * 255))) * 4;
        data[x * 4] = this.lut[index] as number;
        data[x * 4 + 1] = this.lut[index + 1] as number;
        data[x * 4 + 2] = this.lut[index + 2] as number;
        data[x * 4 + 3] = 255;
      }
      ctx.putImageData(this.row as ImageData, 0, n - 1 - i);
    });
  }

  /**
   * The floor: the 30th percentile of the row, eased, so the colours do not
   * flicker. Never more than DEPTH_DB under the strongest signal of the last
   * seconds: a clean generated signal has no noise at all, and against -200 dB
   * of silence the faintest sidebands of its keying would paint whole rows
   * white. That limit holds at once, not eased: a key going down must not
   * flash the row.
   */
  private updateFloor(): void {
    this.sorted.set(this.pixels);
    this.sorted.sort();
    const strongest = this.sorted[this.sorted.length - 1] as number;
    this.strongest = Number.isNaN(this.strongest) ? strongest : Math.max(strongest, this.strongest - 0.3);
    const p = Math.max(this.sorted[Math.floor(this.sorted.length * 0.3)] as number, -130);
    this.noiseFloor = Number.isNaN(this.noiseFloor) ? p : this.noiseFloor + (p - this.noiseFloor) * 0.05;
    this.floor = Math.max(this.noiseFloor, this.strongest - DEPTH_DB);
  }

  private gridStep(): number {
    const [lo, hi] = this.span;
    const perPixel = (hi - lo) / Math.max(1, this.spectrum.clientWidth);
    return [50, 100, 200, 250, 500, 1000, 2000].find((step) => step / perPixel >= 70) ?? 2000;
  }

  private drawSpectrum(): void {
    const ctx = this.spectrum.getContext('2d');
    if (!ctx) return;
    const { width, height } = this.spectrum;
    const dpr = width / Math.max(1, this.spectrum.clientWidth);
    ctx.clearRect(0, 0, width, height);
    const [lo, hi] = this.span;
    const xOf = (f: number) => ((f - lo) / (hi - lo)) * width;

    const step = this.gridStep();
    ctx.strokeStyle = this.colors.grid;
    ctx.fillStyle = this.colors.text;
    ctx.lineWidth = 1;
    ctx.font = `${11 * dpr}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'bottom';
    for (let f = Math.ceil(lo / step) * step; f <= hi; f += step) {
      const x = Math.round(xOf(f)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      const label = f >= 1000 && step >= 500 ? `${f / 1000}k` : String(f);
      ctx.fillText(label, x + 4 * dpr, height - 3 * dpr);
    }

    if (!this.receiver || Number.isNaN(this.floor)) return;
    // Sampled at the waterfall's pixels; the two canvases are as wide, give or take a rounding.
    const levels = new Float32Array(this.from.length);
    this.sample(this.receiver.average, levels);
    const scale = width / Math.max(1, levels.length);
    const top = 6 * dpr;
    const bottom = height - 16 * dpr;
    const yOf = (db: number) => bottom - Math.max(0, Math.min(1, (db - this.floor + 4) / (RANGE_DB + 6))) * (bottom - top);
    ctx.beginPath();
    ctx.moveTo(0, bottom);
    for (let i = 0; i < levels.length; i++) ctx.lineTo(i * scale, yOf(levels[i] as number));
    ctx.lineTo(width, bottom);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, top, 0, bottom);
    fill.addColorStop(0, 'rgba(143, 211, 255, 0.45)');
    fill.addColorStop(1, 'rgba(143, 211, 255, 0.02)');
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < levels.length; i++) {
      const y = yOf(levels[i] as number);
      if (i) ctx.lineTo(i * scale, y);
      else ctx.moveTo(0, y);
    }
    ctx.strokeStyle = this.colors.line;
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();
  }

  private placeMarkers(): void {
    const [lo, hi] = this.span;
    const percent = (f: number) => `${((f - lo) / (hi - lo)) * 100}%`;
    this.markersBox.replaceChildren(
      ...this.markers
        .filter(({ frequency }) => frequency >= lo && frequency <= hi)
        .map(({ slot, frequency, bandwidth }) => {
          const marker = document.createElement('div');
          marker.className = 'marker';
          marker.dataset.slot = String(slot);
          marker.style.left = percent(frequency - bandwidth / 2);
          marker.style.width = `${(bandwidth / (hi - lo)) * 100}%`;
          const label = document.createElement('span');
          label.className = 'marker-label';
          label.textContent = `${SLOT_NAMES[slot] ?? slot} ${Math.round(frequency)}`;
          marker.append(label);
          return marker;
        }),
    );
  }

  private hover(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    const box = this.root.getBoundingClientRect();
    const x = event.clientX - box.left;
    this.cursor.hidden = false;
    this.cursor.style.left = `${x}px`;
    this.cursor.classList.toggle('is-flipped', x > box.width - 90);
    this.cursorLabel.textContent = t('receiver', '{hz} Hz', { hz: Math.round(this.frequencyAt(event.clientX)) });
  }
}
