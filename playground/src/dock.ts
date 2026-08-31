/**
 * The dock's quality control, plus the track-naming helpers the transport
 * bar's menus share. The control re-renders only when its inputs change, so
 * an open <select> is never torn down under the pointer by the half-second
 * refresh.
 */
import type { Constraint, Mattebox, Rendition } from '../../src/index.js';

/** The constraint source every cap chosen here is registered under. */
export const CAP_SOURCE = 'playground';

/** The rungs every quality menu offers, whatever the playlist declares. */
const STANDARD_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240];
const STANDARD_BITRATES = [
  16_000_000, 8_000_000, 6_000_000, 4_000_000, 3_000_000, 2_000_000, 1_500_000, 1_000_000, 500_000,
  250_000,
];

export interface DockDeps {
  engine(): Mattebox | null;
  /** The shareable config; caps are mirrored here so a copied link carries them. */
  constraints: Record<string, Constraint>;
}

export function fmtBitrate(bps: number): string {
  if (bps <= 0) return '—';
  return bps >= 1_000_000
    ? `${(bps / 1_000_000).toFixed(bps % 1_000_000 === 0 ? 0 : 1)} Mbps`
    : `${Math.round(bps / 1000)} kbps`;
}

/** A one-line human description of a rendition: resolution, bitrate, codec. */
export function renditionLabel(r: Rendition): string {
  const parts: string[] = [];
  if (r.height) parts.push(`${r.width ?? '?'}×${r.height}`);
  parts.push(fmtBitrate(r.bitrate));
  if (r.frameRate) parts.push(`${Math.round(r.frameRate)} fps`);
  if (r.codecs) parts.push(r.codecs);
  return parts.join(', ');
}

function describeConstraint(c: Constraint): string {
  const parts: string[] = [];
  if (c.maxHeight !== undefined) parts.push(`≤${c.maxHeight}p`);
  if (c.maxWidth !== undefined) parts.push(`≤${c.maxWidth}w`);
  if (c.maxBitrate !== undefined) parts.push(`≤${fmtBitrate(c.maxBitrate)}`);
  if (c.minBitrate !== undefined) parts.push(`≥${fmtBitrate(c.minBitrate)}`);
  if (c.maxFrameRate !== undefined) parts.push(`≤${c.maxFrameRate} fps`);
  if (c.codecs !== undefined) parts.push(`codecs ${c.codecs.join('/')}`);
  if (c.excludeIds !== undefined && c.excludeIds.length > 0)
    parts.push(`${c.excludeIds.length} excluded`);
  if (c.filter !== undefined) parts.push('filter()');
  return parts.join(' ');
}

// ---- quality --------------------------------------------------------------

let qualitySignature = '';

function applyCap(
  deps: DockDeps,
  patch: { maxHeight?: number | undefined; maxBitrate?: number | undefined },
): void {
  const engine = deps.engine();
  if (engine === null) return;
  const current = engine.quality.constraints.get(CAP_SOURCE) ?? {};
  const next: { maxHeight?: number; maxBitrate?: number } = {
    ...(current.maxHeight !== undefined ? { maxHeight: current.maxHeight } : {}),
    ...(current.maxBitrate !== undefined ? { maxBitrate: current.maxBitrate } : {}),
  };
  if ('maxHeight' in patch) {
    if (patch.maxHeight === undefined) delete next.maxHeight;
    else next.maxHeight = patch.maxHeight;
  }
  if ('maxBitrate' in patch) {
    if (patch.maxBitrate === undefined) delete next.maxBitrate;
    else next.maxBitrate = patch.maxBitrate;
  }
  if (Object.keys(next).length === 0) {
    engine.quality.release(CAP_SOURCE);
    delete deps.constraints[CAP_SOURCE];
  } else {
    engine.quality.constrain(CAP_SOURCE, next);
    deps.constraints[CAP_SOURCE] = next;
  }
  qualitySignature = '';
}

function heightOptions(renditions: readonly Rendition[], selected: number | undefined): string {
  const declared = new Map<number, number>();
  for (const r of renditions) {
    if (r.height) declared.set(r.height, Math.max(declared.get(r.height) ?? 0, r.bitrate));
  }
  const playlist = [...declared.entries()].sort((a, b) => b[0] - a[0]);
  const option = (value: number | '', label: string) =>
    `<option value="${value}"${value === (selected ?? '') ? ' selected' : ''}>${label}</option>`;
  const standard = STANDARD_HEIGHTS.map((h) => option(h, `${h}p`)).join('');
  const fromPlaylist = playlist.map(([h, bps]) => option(h, `${h}p · ${fmtBitrate(bps)}`)).join('');
  const custom =
    selected !== undefined && !STANDARD_HEIGHTS.includes(selected) && !declared.has(selected)
      ? option(selected, `${selected}p`)
      : '';
  return `${option('', 'No height cap')}${custom}<optgroup label="Standard">${standard}</optgroup>${
    fromPlaylist !== '' ? `<optgroup label="This playlist">${fromPlaylist}</optgroup>` : ''
  }`;
}

function bitrateOptions(renditions: readonly Rendition[], selected: number | undefined): string {
  const declared = [...new Set(renditions.map((r) => r.bitrate).filter((b) => b > 0))].sort(
    (a, b) => b - a,
  );
  const option = (value: number | '', label: string) =>
    `<option value="${value}"${value === (selected ?? '') ? ' selected' : ''}>${label}</option>`;
  const standard = STANDARD_BITRATES.map((b) => option(b, fmtBitrate(b))).join('');
  const fromPlaylist = declared.map((b) => option(b, fmtBitrate(b))).join('');
  const custom =
    selected !== undefined && !STANDARD_BITRATES.includes(selected) && !declared.includes(selected)
      ? option(selected, fmtBitrate(selected))
      : '';
  return `${option('', 'No bitrate cap')}${custom}<optgroup label="Standard">${standard}</optgroup>${
    fromPlaylist !== '' ? `<optgroup label="This playlist">${fromPlaylist}</optgroup>` : ''
  }`;
}

export function renderQuality(host: HTMLElement, deps: DockDeps): void {
  const engine = deps.engine();
  if (engine === null) {
    if (qualitySignature !== 'none') {
      host.innerHTML = '<span class="muted">compose a protocol stage to see renditions</span>';
      qualitySignature = 'none';
    }
    return;
  }
  const renditions = engine.quality.renditions;
  const playing = engine.quality.playing;
  const active = engine.quality.active;
  const pinned = engine.quality.pinned;
  const allowed = new Set(engine.quality.allowed.map((r) => r.id));
  const constraints = [...engine.quality.constraints.entries()];
  const cap = engine.quality.constraints.get(CAP_SOURCE);

  const signature = JSON.stringify([
    renditions.map((r) => r.id),
    playing?.id,
    active?.id,
    pinned,
    [...allowed],
    constraints.map(([s, c]) => [s, describeConstraint(c)]),
  ]);
  // Leave the DOM alone while a select is open or focused inside the panel.
  if (signature === qualitySignature || host.contains(document.activeElement)) return;
  qualitySignature = signature;

  if (renditions.length === 0) {
    host.innerHTML =
      '<span class="muted">no video renditions (audio-only or not loaded yet)</span>';
    return;
  }

  const isAuto = pinned === null;
  const caps = constraints.filter(([source]) => source !== CAP_SOURCE);
  const capsText = [
    cap !== undefined ? describeConstraint(cap) : '',
    ...caps.map(([source, c]) => `${source} ${describeConstraint(c)}`),
  ]
    .filter((s) => s !== '')
    .join(', ');
  const modeText = !isAuto
    ? 'pinned to one rendition; press Auto to hand control back'
    : capsText !== ''
      ? `ABR within ${capsText}`
      : 'adapting to bandwidth and the player size';

  const list = renditions
    .map((r) => {
      const state =
        r.id === playing?.id
          ? '<span class="pill ok">playing</span>'
          : r.id === active?.id
            ? '<span class="pill">next</span>'
            : '';
      const blocked = !allowed.has(r.id) ? '<span class="pill bad">capped</span>' : '';
      const pinnedHere = pinned === r.id;
      return `<div class="q-row ${r.id === playing?.id ? 'on' : ''}" title="${r.id}">
        <span class="q-desc">${renditionLabel(r)}</span>
        <span class="q-tags">${state}${blocked}</span>
        <button class="small" data-pin="${r.id}" ${pinnedHere ? 'disabled' : ''}>${
          pinnedHere ? 'pinned' : 'Pin'
        }</button>
      </div>`;
    })
    .join('');

  host.innerHTML = `
    <div class="q-now"><b>Now playing</b>${
      playing !== null
        ? `${playing.height ? `${playing.width ?? '?'}×${playing.height} · ` : ''}${fmtBitrate(
            playing.bitrate,
          )}`
        : '<span class="muted">buffering…</span>'
    }</div>
    <div class="q-caps">
      <button data-auto class="${isAuto ? 'primary' : ''}" title="${
        isAuto ? 'ABR is choosing' : 'Release the pin and let ABR choose'
      }">Auto</button>
      <label>height <select data-cap="height">${heightOptions(renditions, cap?.maxHeight)}</select></label>
      <label>bitrate <select data-cap="bitrate">${bitrateOptions(renditions, cap?.maxBitrate)}</select></label>
      <span class="pill" title="renditions the constraints leave playable">${allowed.size}/${renditions.length} allowed</span>
    </div>
    <div class="q-mode muted">${modeText}</div>
    <div class="q-list">${list}</div>`;

  host.querySelector('[data-auto]')?.addEventListener('click', () => {
    deps.engine()?.quality.auto();
    qualitySignature = '';
  });
  (host.querySelector('[data-cap="height"]') as HTMLSelectElement).addEventListener(
    'change',
    (e) => {
      const value = (e.target as HTMLSelectElement).value;
      applyCap(deps, { maxHeight: value === '' ? undefined : Number(value) });
      (e.target as HTMLSelectElement).blur();
    },
  );
  (host.querySelector('[data-cap="bitrate"]') as HTMLSelectElement).addEventListener(
    'change',
    (e) => {
      const value = (e.target as HTMLSelectElement).value;
      applyCap(deps, { maxBitrate: value === '' ? undefined : Number(value) });
      (e.target as HTMLSelectElement).blur();
    },
  );
  for (const el of host.querySelectorAll('[data-pin]')) {
    el.addEventListener('click', () => {
      deps.engine()?.quality.pin((el as HTMLElement).dataset.pin as string, { apply: 'now' });
      qualitySignature = '';
    });
  }
}

// ---- tracks ---------------------------------------------------------------

export function trackName(t: { id: string; lang?: string; role?: string }): string {
  const base = t.lang ?? t.id;
  return t.role !== undefined && t.role !== 'main' ? `${base} (${t.role})` : base;
}

/** The HLS group id in a track id such as "aud-lo:English", or the whole id. */
function groupOf(id: string): string {
  const colon = id.indexOf(':');
  return colon === -1 ? id : id.slice(0, colon);
}

/**
 * HLS declares the same language once per audio group (a low and a high
 * group, say), which reads as duplicates. One button per name; behind it
 * the track from the active group, so a click never forces a group switch.
 */
export function collapseGroups<T extends { id: string; lang?: string; role?: string }>(
  tracks: readonly T[],
  activeId: string | undefined,
): T[] {
  const activeGroup = activeId !== undefined ? groupOf(activeId) : null;
  const byName = new Map<string, T[]>();
  for (const t of tracks) {
    const name = trackName(t);
    byName.set(name, [...(byName.get(name) ?? []), t]);
  }
  return [...byName.values()].map(
    (group) =>
      group.find((t) => t.id === activeId) ??
      group.find((t) => activeGroup !== null && groupOf(t.id) === activeGroup) ??
      (group[0] as T),
  );
}
