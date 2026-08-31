/**
 * The timeline: five views of the same playback session, one per tab.
 * Buffer shows media time (what is buffered where, and which rendition
 * fills it); the others show wall time (throughput, stalls, frames, and
 * quality switches over the last minutes). A sampler runs every half
 * second and a trace cursor picks up the discrete events; the active tab
 * draws from both. One axis per chart, thin marks, a legend, and a hover
 * readout.
 */
import type { Mattebox, Rendition } from '../../src/index.js';
import { fmtBitrate } from './dock.js';
import { cssVar, THEME_EVENT } from './theme.js';
import { createTraceCursor } from './trace-cursor.js';

export type ChartTab = 'buffer' | 'throughput' | 'stalls' | 'frames' | 'switches';

interface Sample {
  readonly t: number;
  readonly currentTime: number;
  readonly ewmaSlow: number;
  readonly ewmaFast: number;
  readonly ahead: number;
  readonly stalled: boolean;
  readonly droppedDelta: number;
  readonly decodedDelta: number;
  readonly playingId: string | null;
  readonly playingBitrate: number;
  readonly playingHeight: number;
}

interface Mark {
  readonly t: number;
  readonly kind: 'segment' | 'stall' | 'seek' | 'nudge' | 'flush' | 'skip' | 'gap-jump' | 'switch';
  readonly value: number;
  readonly label: string;
  readonly trackId?: string;
}

const MAX_SAMPLES = 2400;
const WINDOWS: Array<[label: string, seconds: number]> = [
  ['30 s', 30],
  ['1 min', 60],
  ['2 min', 120],
  ['5 min', 300],
  ['10 min', 600],
];
const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5'];

const TABS: Array<[ChartTab, string, string]> = [
  ['buffer', 'Buffer', 'what is buffered, which rendition fills it, and where the playhead is'],
  ['throughput', 'Throughput', 'measured segment throughput and the two averages the ABR uses'],
  ['stalls', 'Stalls', 'buffer ahead of the playhead, and when playback stopped'],
  ['frames', 'Frames', 'decoded frames per second and dropped frames'],
  ['switches', 'Switches', 'the rendition playing over time'],
];

export interface Charts {
  attach(engine: Mattebox | null): void;
  /** Sampler tick, every 500 ms. */
  poll(): void;
  /** Draw tick, from the animation frame; cheap when the tab is hidden. */
  draw(): void;
}

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(target, 1);
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function createCharts(
  host: HTMLElement,
  deps: { engine(): Mattebox | null; video: HTMLVideoElement },
): Charts {
  host.innerHTML = `
    <div class="chart-bar">
      <div class="chart-tabs" role="tablist">${TABS.map(
        ([id, label, title]) =>
          `<button role="tab" data-chart="${id}" title="${title}">${label}</button>`,
      ).join('')}</div>
      <label class="chart-window">window <select data-window>${WINDOWS.map(
        ([label, seconds]) =>
          `<option value="${seconds}"${seconds === 120 ? ' selected' : ''}>${label}</option>`,
      ).join('')}</select></label>
    </div>
    <div class="chart-legend"></div>
    <div class="chart-stage">
      <canvas class="chart"></canvas>
      <div class="chart-tip" hidden></div>
    </div>
    <div class="chart-readout muted"></div>`;
  const canvas = host.querySelector('canvas') as HTMLCanvasElement;
  const legend = host.querySelector('.chart-legend') as HTMLElement;
  const readout = host.querySelector('.chart-readout') as HTMLElement;
  const tip = host.querySelector('.chart-tip') as HTMLElement;
  const windowSelect = host.querySelector('[data-window]') as HTMLSelectElement;

  let tab: ChartTab = 'buffer';
  try {
    const saved = localStorage.getItem('mattebox.playground.chart');
    if (TABS.some(([id]) => id === saved)) tab = saved as ChartTab;
  } catch {
    // ignore
  }
  function selectTab(next: ChartTab): void {
    tab = next;
    for (const button of host.querySelectorAll<HTMLElement>('[data-chart]')) {
      button.setAttribute('aria-selected', button.dataset.chart === next ? 'true' : 'false');
    }
    try {
      localStorage.setItem('mattebox.playground.chart', next);
    } catch {
      // ignore
    }
    lastDraw = 0;
    legendSignature = '';
  }
  for (const button of host.querySelectorAll<HTMLElement>('[data-chart]')) {
    button.addEventListener('click', () => selectTab(button.dataset.chart as ChartTab));
  }

  const samples: Sample[] = [];
  const marks: Mark[] = [];
  const cursor = createTraceCursor();
  let engine: Mattebox | null = null;
  let unsubscribe: Array<() => void> = [];
  let lastQuality: { dropped: number; decoded: number } | null = null;
  let lastPlayingId: string | null = null;
  let stallStart: number | null = null;
  let stallCount = 0;
  let stalledTotal = 0;
  let hover: number | null = null;
  let lastDraw = 0;
  let legendSignature = '';
  let colors = palette();

  function palette() {
    return {
      ink: cssVar('--ink'),
      muted: cssVar('--muted'),
      faint: cssVar('--faint'),
      grid: cssVar('--canvas-grid'),
      track: cssVar('--canvas-track'),
      accent: cssVar('--accent'),
      warn: cssVar('--warn'),
      ok: cssVar('--ok'),
      warnBg: cssVar('--warn-bg'),
      badBg: cssVar('--bad-bg'),
      series: SERIES.map((token) => cssVar(token)),
    };
  }
  document.addEventListener(THEME_EVENT, () => {
    colors = palette();
    lastDraw = 0;
  });

  function pushMark(mark: Mark): void {
    marks.push(mark);
    if (marks.length > MAX_SAMPLES * 2) marks.splice(0, marks.length - MAX_SAMPLES * 2);
  }

  function renditionIndex(id: string | null): number {
    const list = engine?.quality.renditions ?? [];
    return Math.max(
      0,
      list.findIndex((r) => r.id === id),
    );
  }

  function poll(): void {
    if (engine === null) return;
    const video = deps.video;
    const state = engine.stats.snapshot();
    for (const entry of cursor.read()) {
      const msg = entry.msg;
      if (msg.type === 'SEGMENT_LOADED' && msg.trackId !== 'manifest' && msg.size > 0) {
        pushMark({
          t: entry.t,
          kind: 'segment',
          value: (msg.size * 8000) / Math.max(msg.rtt, 1),
          label: `${msg.trackId} #${msg.seq}`,
          trackId: msg.trackId,
        });
      } else if (msg.type === 'STALLED') {
        pushMark({
          t: entry.t,
          kind: 'stall',
          value: msg.at,
          label: `stalled at ${msg.at.toFixed(1)}s`,
        });
      } else if (msg.type === 'SEEKING') {
        pushMark({
          t: entry.t,
          kind: 'seek',
          value: msg.to,
          label: `seek to ${msg.to.toFixed(1)}s`,
        });
      }
      for (const effect of entry.effects) {
        if (effect.kind !== 'emit') continue;
        const name = effect.event.replace('recovery:', '');
        if (name === 'nudge' || name === 'flush' || name === 'skip' || name === 'gap-jump') {
          pushMark({ t: entry.t, kind: name, value: video.currentTime, label: `recovery ${name}` });
        }
      }
    }
    const playing = engine.quality.playing;
    const quality = video.getVideoPlaybackQuality?.();
    const dropped = quality?.droppedVideoFrames ?? 0;
    const decoded = quality?.totalVideoFrames ?? 0;
    const droppedDelta = lastQuality === null ? 0 : Math.max(0, dropped - lastQuality.dropped);
    const decodedDelta = lastQuality === null ? 0 : Math.max(0, decoded - lastQuality.decoded);
    lastQuality = { dropped, decoded };
    let ahead = 0;
    for (let i = 0; i < video.buffered.length; i += 1) {
      if (
        video.buffered.start(i) <= video.currentTime + 0.25 &&
        video.buffered.end(i) > video.currentTime
      ) {
        ahead = video.buffered.end(i) - video.currentTime;
      }
    }
    const stalled =
      !video.paused &&
      !video.ended &&
      !video.seeking &&
      video.readyState < 3 &&
      video.currentTime > 0;
    const now = performance.now();
    if (stalled && stallStart === null) {
      stallStart = now;
      stallCount += 1;
    } else if (!stalled && stallStart !== null) {
      stalledTotal += (now - stallStart) / 1000;
      stallStart = null;
    }
    if (playing !== null && lastPlayingId !== null && playing.id !== lastPlayingId) {
      pushMark({
        t: now,
        kind: 'switch',
        value: playing.height ?? playing.bitrate,
        label: `now ${label(playing)}`,
      });
    }
    if (playing !== null) lastPlayingId = playing.id;
    samples.push({
      t: now,
      currentTime: video.currentTime,
      ewmaSlow: state.stats.throughputEwma,
      ewmaFast: state.stats.throughputFastEwma,
      ahead,
      stalled,
      droppedDelta,
      decodedDelta,
      playingId: playing?.id ?? null,
      playingBitrate: playing?.bitrate ?? 0,
      playingHeight: playing?.height ?? 0,
    });
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  }

  function label(r: Rendition): string {
    return r.height ? `${r.height}p, ${fmtBitrate(r.bitrate)}` : fmtBitrate(r.bitrate);
  }

  // ---- drawing helpers -----------------------------------------------------

  interface Frame {
    ctx: CanvasRenderingContext2D;
    w: number;
    h: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
    dpr: number;
  }

  function frame(): Frame | null {
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    const dpr = devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
    return { ctx, w: cssW, h: cssH, left: 48, right: cssW - 12, top: 10, bottom: cssH - 22, dpr };
  }

  function timeWindow(): { t0: number; t1: number } {
    const t1 = performance.now();
    return { t0: t1 - Number(windowSelect.value) * 1000, t1 };
  }

  function drawWallAxis(f: Frame, t0: number, t1: number): (t: number) => number {
    const x = (t: number) => f.left + ((t - t0) / (t1 - t0)) * (f.right - f.left);
    const seconds = (t1 - t0) / 1000;
    const step = niceStep(seconds, 6);
    f.ctx.strokeStyle = colors.grid;
    f.ctx.fillStyle = colors.faint;
    f.ctx.lineWidth = 1;
    f.ctx.textAlign = 'center';
    for (let s = step; s < seconds; s += step) {
      const px = x(t1 - s * 1000);
      f.ctx.beginPath();
      f.ctx.moveTo(px, f.top);
      f.ctx.lineTo(px, f.bottom);
      f.ctx.stroke();
      f.ctx.fillText(`-${s >= 60 ? fmtClock(s) : `${s}s`}`, px, f.h - 6);
    }
    f.ctx.fillText('now', f.right, f.h - 6);
    return x;
  }

  function drawYAxis(f: Frame, max: number, unit: (v: number) => string): (v: number) => number {
    const y = (v: number) => f.bottom - (v / max) * (f.bottom - f.top);
    const step = niceStep(max, 4);
    f.ctx.strokeStyle = colors.grid;
    f.ctx.fillStyle = colors.faint;
    f.ctx.textAlign = 'right';
    for (let v = 0; v <= max + 1e-9; v += step) {
      const py = y(v);
      f.ctx.beginPath();
      f.ctx.moveTo(f.left, py);
      f.ctx.lineTo(f.right, py);
      f.ctx.stroke();
      f.ctx.fillText(unit(v), f.left - 6, py + 4);
    }
    return y;
  }

  function line(
    f: Frame,
    points: Array<[number, number]>,
    color: string,
    options: { dashed?: boolean; step?: boolean; width?: number } = {},
  ): void {
    if (points.length === 0) return;
    f.ctx.strokeStyle = color;
    f.ctx.lineWidth = options.width ?? 2;
    f.ctx.setLineDash(options.dashed ? [4, 4] : []);
    f.ctx.beginPath();
    points.forEach(([px, py], i) => {
      if (i === 0) f.ctx.moveTo(px, py);
      else if (options.step) {
        const prev = points[i - 1] as [number, number];
        f.ctx.lineTo(px, prev[1]);
        f.ctx.lineTo(px, py);
      } else f.ctx.lineTo(px, py);
    });
    f.ctx.stroke();
    f.ctx.setLineDash([]);
  }

  function dot(f: Frame, px: number, py: number, color: string, r = 3): void {
    f.ctx.fillStyle = color;
    f.ctx.beginPath();
    f.ctx.arc(px, py, r, 0, Math.PI * 2);
    f.ctx.fill();
  }

  function marker(f: Frame, px: number, color: string, glyph: string): void {
    f.ctx.strokeStyle = color;
    f.ctx.lineWidth = 1;
    f.ctx.setLineDash([2, 3]);
    f.ctx.beginPath();
    f.ctx.moveTo(px, f.top);
    f.ctx.lineTo(px, f.bottom);
    f.ctx.stroke();
    f.ctx.setLineDash([]);
    f.ctx.fillStyle = color;
    f.ctx.textAlign = 'center';
    f.ctx.fillText(glyph, px, f.top + 10);
  }

  function setLegend(items: Array<[string, string, string?]>): void {
    const signature = JSON.stringify(items);
    if (signature === legendSignature) return;
    legendSignature = signature;
    legend.innerHTML = items
      .map(
        ([text, color, style]) =>
          `<span class="legend-item"><span class="legend-swatch ${style ?? ''}" style="--swatch:${color}"></span>${text}</span>`,
      )
      .join('');
  }

  function visibleSamples(t0: number): Sample[] {
    let start = samples.findIndex((s) => s.t >= t0);
    if (start < 0) start = samples.length;
    return samples.slice(Math.max(0, start - 1));
  }

  // ---- charts ----------------------------------------------------------------

  function drawBuffer(f: Frame): void {
    if (engine === null) return;
    const video = deps.video;
    const state = engine.stats.snapshot();
    const duration = Math.max(
      state.presentation?.duration ?? 0,
      Number.isFinite(video.duration) ? video.duration : 0,
      1,
    );
    const live = state.live;
    let d0 = 0;
    let d1 = duration;
    if (live !== null) {
      d0 = live.span.start;
      d1 = Math.max(live.span.end, video.currentTime + 10);
    } else if (duration > 600) {
      d0 = Math.max(0, video.currentTime - 60);
      d1 = Math.min(duration, d0 + 180);
    }
    const x = (t: number) => f.left + ((t - d0) / (d1 - d0)) * (f.right - f.left);
    const renditions = engine.quality.renditions;
    const buffers = [...state.buffers.entries()];
    const rows = Math.max(buffers.length, 1);
    const rowGap = 8;
    const rowH = Math.min(34, (f.bottom - f.top - rowGap * (rows - 1)) / rows);

    // media-time axis
    const step = niceStep(d1 - d0, 8);
    f.ctx.strokeStyle = colors.grid;
    f.ctx.fillStyle = colors.faint;
    f.ctx.textAlign = 'center';
    for (let t = Math.ceil(d0 / step) * step; t <= d1; t += step) {
      const px = x(t);
      f.ctx.beginPath();
      f.ctx.moveTo(px, f.top);
      f.ctx.lineTo(px, f.bottom);
      f.ctx.stroke();
      f.ctx.fillText(fmtClock(t), px, f.h - 6);
    }

    buffers.forEach(([sbId, buffer], row) => {
      const y = f.top + row * (rowH + rowGap);
      f.ctx.fillStyle = colors.track;
      f.ctx.fillRect(f.left, y, f.right - f.left, rowH);
      for (const [range, renditionId] of state.quality.appendLog) {
        const color = colors.series[renditionIndex(renditionId) % colors.series.length] as string;
        f.ctx.fillStyle = color;
        f.ctx.globalAlpha = 0.3;
        const a = Math.max(x(range.start), f.left);
        const b = Math.min(x(range.end), f.right);
        if (b > a) f.ctx.fillRect(a, y, b - a, rowH);
        f.ctx.globalAlpha = 1;
      }
      for (const range of buffer.ranges) {
        f.ctx.fillStyle = colors.ink;
        const a = Math.max(x(range.start), f.left);
        const b = Math.min(x(range.end), f.right);
        if (b > a) f.ctx.fillRect(a, y + rowH - 4, b - a, 3);
      }
      f.ctx.fillStyle = colors.muted;
      f.ctx.textAlign = 'left';
      f.ctx.fillText(sbId.replace('sb:', ''), f.left + 4, y + 12);
    });
    if (live !== null) {
      marker(f, x(live.edge), colors.warn, 'edge');
    }
    f.ctx.fillStyle = colors.accent;
    f.ctx.fillRect(x(video.currentTime) - 1, f.top, 2, f.bottom - f.top);

    setLegend([
      ...renditions.map(
        (r, i) => [label(r), colors.series[i % colors.series.length] as string] as [string, string],
      ),
      ['buffered range', colors.ink, 'line'],
      ['playhead', colors.accent, 'line'],
    ]);
    const ahead = samples[samples.length - 1]?.ahead ?? 0;
    readout.textContent = `${fmtClock(video.currentTime)} of ${live !== null ? 'live' : fmtClock(duration)}, ${ahead.toFixed(1)}s buffered ahead${
      live !== null ? `, window ${fmtClock(live.span.start)} to ${fmtClock(live.span.end)}` : ''
    }`;
  }

  function drawThroughput(f: Frame): void {
    const { t0, t1 } = timeWindow();
    const view = visibleSamples(t0);
    const segs = marks.filter((m) => m.kind === 'segment' && m.t >= t0);
    const max =
      Math.max(
        1_000_000,
        ...view.map((s) => Math.max(s.ewmaSlow, s.ewmaFast, s.playingBitrate)),
        ...segs.map((m) => m.value),
      ) * 1.15;
    const x = drawWallAxis(f, t0, t1);
    const y = drawYAxis(f, max, (v) => `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}`);
    const video = colors.series[0] as string;
    const audio = colors.series[4] as string;
    for (const m of segs) {
      dot(
        f,
        x(m.t),
        y(m.value),
        m.trackId?.startsWith('aud') || m.trackId?.includes('audio') ? audio : video,
        2.5,
      );
    }
    line(
      f,
      view.map((s) => [x(s.t), y(s.ewmaSlow)]),
      colors.series[1] as string,
    );
    line(
      f,
      view.map((s) => [x(s.t), y(s.ewmaFast)]),
      colors.series[2] as string,
      { dashed: true },
    );
    line(
      f,
      view.map((s) => [x(s.t), y(s.playingBitrate)]),
      colors.muted,
      { step: true, width: 1.5 },
    );
    setLegend([
      ['video segment', video, 'dot'],
      ['audio segment', audio, 'dot'],
      ['slow average', colors.series[1] as string, 'line'],
      ['fast average', colors.series[2] as string, 'dashed'],
      ['playing bitrate', colors.muted, 'line'],
    ]);
    const last = samples[samples.length - 1];
    readout.textContent =
      last === undefined
        ? 'Mbps over time'
        : `Mbps. Now: slow ${fmtBitrate(last.ewmaSlow)}, fast ${fmtBitrate(last.ewmaFast)}, playing ${fmtBitrate(last.playingBitrate)}`;
    drawHover(f, x, view, (s) => `slow ${fmtBitrate(s.ewmaSlow)}, fast ${fmtBitrate(s.ewmaFast)}`);
  }

  function drawStalls(f: Frame): void {
    const { t0, t1 } = timeWindow();
    const view = visibleSamples(t0);
    const max = Math.max(5, ...view.map((s) => s.ahead)) * 1.15;
    const x = drawWallAxis(f, t0, t1);
    // stalled bands first, under everything
    f.ctx.fillStyle = colors.badBg;
    let bandStart: number | null = null;
    view.forEach((s, i) => {
      if (s.stalled && bandStart === null) bandStart = s.t;
      const endBand = bandStart !== null && (!s.stalled || i === view.length - 1);
      if (endBand && bandStart !== null) {
        f.ctx.fillRect(x(bandStart), f.top, Math.max(2, x(s.t) - x(bandStart)), f.bottom - f.top);
        bandStart = null;
      }
    });
    const y = drawYAxis(f, max, (v) => `${v.toFixed(0)}s`);
    line(
      f,
      view.map((s) => [x(s.t), y(s.ahead)]),
      colors.series[0] as string,
    );
    for (const m of marks) {
      if (m.t < t0) continue;
      if (m.kind === 'stall') marker(f, x(m.t), colors.accent, '!');
      else if (m.kind === 'seek') marker(f, x(m.t), colors.faint, '⇢');
      else if (m.kind !== 'segment' && m.kind !== 'switch')
        marker(f, x(m.t), colors.warn, m.kind[0]?.toUpperCase() ?? '');
    }
    setLegend([
      ['seconds buffered ahead', colors.series[0] as string, 'line'],
      ['stalled', colors.badBg, 'band'],
      ['stall event', colors.accent, 'mark'],
      ['recovery: N nudge, F flush, S skip, G gap jump', colors.warn, 'mark'],
      ['seek', colors.faint, 'mark'],
    ]);
    const current = stallStart !== null ? (performance.now() - stallStart) / 1000 : 0;
    readout.textContent = `${stallCount} stall${stallCount === 1 ? '' : 's'}, ${(stalledTotal + current).toFixed(1)}s stalled in total${
      stallStart !== null ? ', stalled now' : ''
    }`;
    drawHover(f, x, view, (s) => `${s.ahead.toFixed(1)}s ahead${s.stalled ? ', stalled' : ''}`);
  }

  function drawFrames(f: Frame): void {
    const { t0, t1 } = timeWindow();
    const view = visibleSamples(t0);
    const fps = view.map((s, i) => {
      const prev = view[i - 1];
      const dt = prev === undefined ? 0.5 : Math.max((s.t - prev.t) / 1000, 0.05);
      return s.decodedDelta / dt;
    });
    const max = Math.max(30, ...fps) * 1.15;
    const x = drawWallAxis(f, t0, t1);
    const y = drawYAxis(f, max, (v) => `${v.toFixed(0)}`);
    // dropped frames as thin bars from the baseline, in the accent color
    const maxDrop = Math.max(1, ...view.map((s) => s.droppedDelta));
    f.ctx.fillStyle = colors.accent;
    for (const s of view) {
      if (s.droppedDelta === 0) continue;
      const hgt = ((f.bottom - f.top) * 0.6 * s.droppedDelta) / maxDrop;
      f.ctx.fillRect(x(s.t) - 1.5, f.bottom - hgt, 3, hgt);
    }
    line(
      f,
      view.map((s, i) => [x(s.t), y(fps[i] as number)]),
      colors.series[0] as string,
    );
    setLegend([
      ['decoded frames per second', colors.series[0] as string, 'line'],
      ['dropped frames per sample (relative)', colors.accent, 'bar'],
    ]);
    const q = deps.video.getVideoPlaybackQuality?.();
    readout.textContent =
      q === undefined
        ? 'frames per second'
        : `${q.totalVideoFrames} decoded, ${q.droppedVideoFrames} dropped${
            q.totalVideoFrames > 0
              ? ` (${((100 * q.droppedVideoFrames) / q.totalVideoFrames).toFixed(2)}%)`
              : ''
          } this session`;
    drawHover(
      f,
      x,
      view,
      (s, i) => `${(fps[i] as number).toFixed(0)} fps, ${s.droppedDelta} dropped`,
    );
  }

  function drawSwitches(f: Frame): void {
    const { t0, t1 } = timeWindow();
    const view = visibleSamples(t0);
    const renditions = engine?.quality.renditions ?? [];
    const useHeight = renditions.some((r) => r.height);
    const levels = renditions.map((r) => (useHeight ? (r.height ?? 0) : r.bitrate));
    const max = Math.max(1, ...levels) * 1.15;
    const x = drawWallAxis(f, t0, t1);
    const y = (v: number) => f.bottom - (v / max) * (f.bottom - f.top);
    f.ctx.strokeStyle = colors.grid;
    f.ctx.fillStyle = colors.faint;
    f.ctx.textAlign = 'right';
    renditions.forEach((r, i) => {
      const py = y(levels[i] as number);
      f.ctx.beginPath();
      f.ctx.moveTo(f.left, py);
      f.ctx.lineTo(f.right, py);
      f.ctx.stroke();
      f.ctx.fillText(useHeight ? `${r.height}p` : fmtBitrate(r.bitrate), f.left - 6, py + 4);
    });
    const points: Array<[number, number]> = view.map((s) => [
      x(s.t),
      y(useHeight ? s.playingHeight : s.playingBitrate),
    ]);
    line(f, points, colors.series[0] as string, { step: true });
    for (const m of marks) {
      if (m.t >= t0 && m.kind === 'switch') marker(f, x(m.t), colors.warn, '↕');
    }
    setLegend([
      [useHeight ? 'playing height' : 'playing bitrate', colors.series[0] as string, 'line'],
      ['switch', colors.warn, 'mark'],
    ]);
    const switches = marks.filter((m) => m.kind === 'switch').length;
    const playing = engine?.quality.playing;
    readout.textContent = `${switches} switch${switches === 1 ? '' : 'es'} this session${
      playing ? `, now ${label(playing)}` : ''
    }`;
    drawHover(f, x, view, (s) => {
      const r = renditions.find((c) => c.id === s.playingId);
      return r ? label(r) : 'nothing playing';
    });
  }

  function drawHover(
    f: Frame,
    x: (t: number) => number,
    view: Sample[],
    text: (s: Sample, i: number) => string,
  ): void {
    if (hover === null || view.length === 0) {
      tip.hidden = true;
      return;
    }
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    view.forEach((s, i) => {
      const d = Math.abs(x(s.t) - (hover as number));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const s = view[best] as Sample;
    const px = x(s.t);
    f.ctx.strokeStyle = colors.muted;
    f.ctx.lineWidth = 1;
    f.ctx.beginPath();
    f.ctx.moveTo(px, f.top);
    f.ctx.lineTo(px, f.bottom);
    f.ctx.stroke();
    tip.hidden = false;
    tip.textContent = `${fmtClock(s.currentTime)}, ${text(s, best)}`;
    // Flip to the left half of the crosshair once past the middle, so the
    // readout never runs off the canvas.
    if (px > f.w / 2) {
      tip.style.left = 'auto';
      tip.style.right = `${f.w - px + 10}px`;
    } else {
      tip.style.right = 'auto';
      tip.style.left = `${px + 10}px`;
    }
  }

  canvas.addEventListener('mousemove', (e) => {
    hover = e.offsetX;
    lastDraw = 0;
  });
  canvas.addEventListener('mouseleave', () => {
    hover = null;
    tip.hidden = true;
    lastDraw = 0;
  });
  windowSelect.addEventListener('change', () => {
    lastDraw = 0;
  });
  selectTab(tab);

  return {
    attach(next) {
      for (const off of unsubscribe) off();
      unsubscribe = [];
      engine = next;
      cursor.reset(next);
      samples.length = 0;
      marks.length = 0;
      lastQuality = null;
      lastPlayingId = null;
      stallStart = null;
      stallCount = 0;
      stalledTotal = 0;
      lastDraw = 0;
      legendSignature = '';
    },
    poll,
    draw() {
      if (canvas.offsetParent === null) return;
      const now = performance.now();
      // Buffer follows the playhead every frame; the wall-time charts move at the sampler's pace.
      if (tab !== 'buffer' && now - lastDraw < 250) return;
      lastDraw = now;
      const f = frame();
      if (f === null) return;
      if (engine === null) {
        f.ctx.fillStyle = colors.muted;
        f.ctx.textAlign = 'center';
        f.ctx.fillText('compose an engine to see the timeline', f.w / 2, f.h / 2);
        return;
      }
      switch (tab) {
        case 'buffer':
          drawBuffer(f);
          break;
        case 'throughput':
          drawThroughput(f);
          break;
        case 'stalls':
          drawStalls(f);
          break;
        case 'frames':
          drawFrames(f);
          break;
        case 'switches':
          drawSwitches(f);
          break;
      }
    },
  };
}
