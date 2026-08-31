/**
 * The Mattebox playground: a player you can drive, with the engine's
 * internals one disclosure away. The layout is a workbench: a sticky dock
 * (player, status, quality, tracks) that stays in view, and an inspector
 * column of panels that scrolls beside it, so a change made in any panel is
 * seen on the player at once.
 */

import logoUrl from '../../docs/logo.svg';
import type {
  Constraint,
  Mattebox,
  Presentation,
  SliceReducer,
  Stage,
  StageContext,
  TraceEntry,
} from '../../src/index.js';
import { createReducer, initialState, mattebox, replay } from '../../src/index.js';
import { parse as parseDash } from '../../src/protocols/dash-cmaf/parse.js';
import { parse, parseMediaPlaylist } from '../../src/protocols/hls-cmaf/parse.js';
import emeCore from '../../src/stages/eme-core/index.js';
import emeFairplay from '../../src/stages/eme-fairplay/index.js';
import { renderCapabilities } from './capabilities.js';
import type { CatalogueEntry } from './catalogue.js';
import { CATALOGUE, PRESETS, STREAMS } from './catalogue.js';
import { createCharts } from './charts.js';
import { fmtBitrate, renderQuality } from './dock.js';
import type { FaultConfig } from './faults.js';
import { createFaultyFetch, defaultFaults } from './faults.js';
import type { Level, Source } from './log.js';
import { createEventLog, toJson } from './log.js';
import type { Check, ParsedManifest } from './manifest-checks.js';
import { checkManifest } from './manifest-checks.js';
import type { BusinessUnit, Composition, IlResource, SearchResult } from './srgssr.js';
import {
  BUSINESS_UNITS,
  certificateUrlFor,
  fetchComposition,
  fmtDuration,
  licenseUrlsFor,
  searchMedia,
  tokenize,
} from './srgssr.js';
import { bindThemeToggle } from './theme.js';
import { createTransportBar } from './transport.js';

interface PlaygroundConfig {
  stages: string[];
  /** True once the composition is edited by hand; a preset match no longer takes over the table. */
  custom?: boolean;
  stream: string;
  constraints: Record<string, Constraint>;
  /** DRM license server URL, applied to eme-core through engine.drm.setLicenseUrl. */
  licenseUrl?: string;
  /** Preferred DRM key system, or undefined to let eme-core auto-negotiate. */
  keySystem?: string;
  /** Per-key-system license URLs, as the SRG SSR integration layer provides them. */
  licenseUrls?: Record<string, string>;
  /** FairPlay application certificate, for eme-fairplay. */
  certificateUrl?: string;
  /** The SRG SSR title behind the current stream, for the status line. */
  srgTitle?: string;
  /** WebVTT sprite-sheet thumbnail track, loaded into the thumbnails stage. */
  thumbnails?: string;
}

/** The EME key system string behind each vendor name the selector offers. */
const KEY_SYSTEMS: Record<string, string> = {
  Widevine: 'com.widevine.alpha',
  PlayReady: 'com.microsoft.playready',
  FairPlay: 'com.apple.fps',
  ClearKey: 'org.w3.clearkey',
};

const app = document.querySelector('#app') as HTMLElement;

// ---- configuration state, round-tripped through ?config= ----------------

/** Every built stage, so the playground opens with the full suite composed. */
function fullSuite(): string[] {
  return CATALOGUE.filter((entry) => entry.factory !== null).map((entry) => entry.name);
}

function readConfig(): PlaygroundConfig {
  const raw = new URLSearchParams(location.search).get('config');
  const fallback: PlaygroundConfig = {
    stages: [...(PRESETS.find((p) => p.name === 'full')?.stages ?? fullSuite())],
    stream: STREAMS[0]?.url ?? '',
    constraints: {},
  };
  if (raw === null) return fallback;
  try {
    return { ...fallback, ...JSON.parse(atob(raw)) };
  } catch {
    return fallback;
  }
}

const config = readConfig();
const faults: FaultConfig = defaultFaults();

function shareUrl(): string {
  const encoded = btoa(JSON.stringify(config));
  const url = new URL(location.href);
  url.searchParams.set('config', encoded);
  return url.href;
}

// ---- engine lifecycle ----------------------------------------------------

let engine: Mattebox | null = null;
const video = document.createElement('video');
video.muted = true;
video.controls = true;
video.playsInline = true;

function selectedStages(): Stage[] {
  return CATALOGUE.filter((e) => e.factory !== null && config.stages.includes(e.name)).map((e) => {
    // eme-core takes the license URL and key-system preference the DRM panel
    // chose, so an encrypted stream is ready the moment it loads.
    if (e.name === 'eme-core') {
      const preferred = config.keySystem !== undefined ? KEY_SYSTEMS[config.keySystem] : undefined;
      return emeCore({
        ...(config.licenseUrl !== undefined && config.licenseUrl !== ''
          ? { licenseUrl: config.licenseUrl }
          : {}),
        ...(config.licenseUrls !== undefined && Object.keys(config.licenseUrls).length > 0
          ? { licenseUrls: config.licenseUrls }
          : {}),
        ...(preferred !== undefined ? { preferredKeySystems: [preferred] } : {}),
      });
    }
    if (e.name === 'eme-fairplay') {
      return emeFairplay(
        config.certificateUrl !== undefined ? { certificateUrl: config.certificateUrl } : {},
      );
    }
    return (e.factory as () => Stage)();
  });
}

function drmApi(): { setLicenseUrl(url: string): void; readonly keySystem: string | null } | null {
  return (
    (engine as { drm?: { setLicenseUrl(url: string): void; keySystem: string | null } } | null)
      ?.drm ?? null
  );
}

async function rebuild(): Promise<void> {
  if (engine !== null) await engine.detach();
  const { fetchImpl: faulty } = createFaultyFetch(faults);
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const response = await faulty(url, init);
    if (response.ok && isManifestUrl(url)) {
      response
        .clone()
        .text()
        .then((text) => captureManifest(url, text))
        .catch(() => undefined);
    }
    return response;
  };
  try {
    engine = mattebox({ stages: selectedStages(), transport: { fetchImpl } });
  } catch (error) {
    engine = null;
    const banner = document.querySelector('#composeError') as HTMLElement | null;
    if (banner !== null) {
      banner.textContent = `Composition error: ${String((error as Error).message ?? error)}`;
      banner.hidden = false;
    }
    return;
  }
  const banner = document.querySelector('#composeError') as HTMLElement | null;
  if (banner !== null) banner.hidden = true;
  await engine.attach(video);
  log.attach(engine, video);
  charts.attach(engine);
  for (const [source, constraint] of Object.entries(config.constraints)) {
    engine.quality.constrain(source, constraint);
  }
  // Point eme-core at the license server before the first encrypted event, so
  // an encrypted stream has somewhere to send its challenge the moment it
  // loads. This is why the license is set as part of loading, not after.
  const drm = drmApi();
  if (config.licenseUrl !== undefined && config.licenseUrl !== '' && drm !== null) {
    drm.setLicenseUrl(config.licenseUrl);
  }
  manifests.clear();
  manifestOptionsSignature = '';
  if (config.stream !== '') engine.load(config.stream);
  void loadThumbnails();
  stall.lastTime = -1;
  stall.since = performance.now();
  renderStatic();
}

// ---- replay: rebuild the composed reducer without touching the engine ----

function composedReducer() {
  const slices: Array<readonly [string, SliceReducer]> = [];
  const manifestTypes = new Set<string>();
  const hooks: {
    abr?: Parameters<StageContext['registerChooser']>[0];
    manifestTypes: ReadonlySet<string>;
  } = { manifestTypes };
  for (const stage of selectedStages()) {
    for (const capability of stage.provides ?? []) {
      // A MIME type capability names a manifest format; the reducer's LOAD
      // check reads the same set the live engine composed.
      if (typeof capability === 'string' && capability.includes('/')) {
        manifestTypes.add(capability.toLowerCase());
      }
    }
    stage.install({
      element: video,
      registerSink: () => undefined,
      registerParser: () => undefined,
      registerTransform: () => undefined,
      registerNamespace: () => undefined,
      getState: () => initialState(),
      addRequestHook: () => () => undefined,
      request: async () => new Response(),
      registerChooser: (chooser) => {
        hooks.abr = chooser;
      },
      registerSwitchPolicy: () => undefined,
      registerTypeProbe: () => undefined,
      reduce: (name, reducer) => slices.push([name, reducer as SliceReducer]),
      dispatch: () => undefined,
      emit: () => undefined,
      on: () => () => undefined,
    });
  }
  return createReducer(slices, undefined, hooks);
}

// ---- layout --------------------------------------------------------------

app.innerHTML = `
  <header class="topbar">
    <div class="brand">
      <img class="logo" src="${logoUrl}" alt="">
      <div class="brand-text">
        <h1>Mattebox <span class="tag">playground</span></h1>
        <p class="tagline">Pick a stream, watch it play, and open a tab to see what the engine is doing.</p>
      </div>
    </div>
    <div class="topbar-meta">
      <button id="themeToggle" class="theme-toggle" type="button"></button>
      <button id="share">Copy link</button>
      <span id="shared" class="muted"></span>
    </div>
  </header>

  <main class="page">
    <div id="composeError" class="banner" hidden></div>

    <div class="player-slot" id="playerSlot">
      <div class="player-block" id="playerBlock">
        <section class="player-card" id="player"></section>
      </div>
    </div>

    <div class="pinned" id="pinned">
      <div class="deck">
        <div id="transport" class="transport"></div>
        <div id="playbackStatus" class="pstatus wait">
          <span class="dot"></span>
          <span id="playbackText">idle</span>
          <span id="playbackSub" class="pstatus-sub"></span>
        </div>
      </div>
      <nav class="tabs" id="tabs" role="tablist">
      <button role="tab" data-tab="stream">Stream</button>
      <button role="tab" data-tab="playback">Quality</button>
      <button role="tab" data-tab="diagnostics">Diagnostics</button>
      <button role="tab" data-tab="support">Browser support</button>
      <button role="tab" data-tab="composition">Composition <span id="compositionSummary" class="tab-note"></span></button>
      <button role="tab" data-tab="network">Network faults</button>
      <button role="tab" data-tab="manifest">Manifest</button>
      <button id="backToPlayer" class="small tab-back" type="button" title="Scroll back up to the picture">▲ Player</button>
      </nav>
    </div>

    <section class="panel tab-panel" data-panel="stream" id="streamPanel" hidden>
      <div class="panel-head"><h2>Stream</h2><span class="hint">choose a demo source or paste a manifest URL</span></div>
      <div class="controls">
        <select id="streamSelect" class="grow"></select>
      </div>
      <div class="controls">
        <input id="streamUrl" class="grow" placeholder="https://…/master.m3u8  or  manifest.mpd">
        <button id="loadUrl" class="primary">Load</button>
      </div>
      <div id="drmRow" class="controls">
        <input id="licenseUrl" class="grow" placeholder="DRM license URL (for encrypted streams)">
        <select id="keySystem" title="Preferred DRM key system">
          <option value="">Auto-detect</option>
          <option value="Widevine">Widevine</option>
          <option value="PlayReady">PlayReady</option>
          <option value="FairPlay">FairPlay</option>
          <option value="ClearKey">ClearKey</option>
        </select>
        <span id="drmState" class="pill">no DRM</span>
      </div>
      <p class="hint drm-hint">The license and key-system preference apply when you load, so encrypted content is ready before its first key request. Leave the vendor on Auto-detect to let the browser negotiate.</p>
      <div class="controls">
        <input id="thumbUrl" class="grow" placeholder="Thumbnail track URL (WebVTT sprite sheet, optional)">
        <span id="thumbState" class="pill">no thumbnails</span>
      </div>

      <div class="sub srg">
        <div class="panel-head"><h3>SRG SSR content</h3><span class="hint">search the integration layer, or paste a URN, then pick the resource to play</span></div>
        <div class="controls">
          <select id="srgBu" title="Business unit"></select>
          <input id="srgQuery" class="grow" placeholder="Search a title, or paste urn:rts:video:…">
          <button id="srgGo">Search</button>
          <span id="srgState" class="muted"></span>
        </div>
        <div id="srgResults" class="srg-results" hidden></div>
        <div id="srgComposition" class="srg-composition" hidden></div>
      </div>
    </section>

    <section class="panel tab-panel" data-panel="playback" hidden>
      <div class="panel-head"><h2>Quality</h2><span class="hint">what plays now, and how it was chosen</span></div>
      <div id="quality"></div>
    </section>

    <section class="panel tab-panel" id="diagnostics" data-panel="diagnostics" hidden>
      <div class="sub">
        <div class="panel-head"><h3>Event log</h3><span class="hint">commands, facts, engine events, and media element events, in order. Click a line for its JSON.</span></div>
        <div class="controls log-controls">
          <input id="logFilter" class="grow" placeholder="filter by type or message">
          <select id="logSource" title="Which source to show">
            <option value="all">all sources</option>
            <option value="command">commands</option>
            <option value="fact">facts</option>
            <option value="event">engine events</option>
            <option value="media">media element</option>
          </select>
          <label class="chk"><input type="checkbox" id="lvlError" checked><span class="lvl-dot error"></span><span>errors</span></label>
          <label class="chk"><input type="checkbox" id="lvlWarn" checked><span class="lvl-dot warn"></span><span>warnings</span></label>
          <label class="chk"><input type="checkbox" id="lvlInfo" checked><span>info</span></label>
          <label class="chk" title="TIME_UPDATE, TICK, throughput samples, buffer updates"><input type="checkbox" id="lvlDebug"><span>verbose</span></label>
        </div>
        <div id="log" class="log"></div>
        <div class="controls">
          <button id="replayBtn" title="Replay the trace through a fresh reducer; up to the opened entry when one is open">Replay</button>
          <button id="exportBtn" title="Download the engine trace as JSON">Export trace</button>
          <button id="reportBtn" title="Download the trace, this log, the stream config, the browser, and the last error in one file">Export report</button>
          <button id="clearLog">Clear</button>
          <span id="replayOut" class="pill"></span>
          <span id="logCount" class="muted"></span>
        </div>
      </div>

      <div class="sub">
        <div class="panel-head"><h3>Timeline</h3><span class="hint">the session over time: buffer, throughput, stalls, frames, and switches</span></div>
        <div id="charts" class="charts"></div>
      </div>

      <div class="sub">
        <div class="panel-head"><h3>Engine</h3><span class="hint">the kernel state behind the panels above</span></div>
        <div class="table-wrap"><table class="table kv-table"><tbody id="engineInfo"></tbody></table></div>
      </div>
    </section>

    <section class="panel tab-panel" data-panel="support" hidden>
      <div class="panel-head"><h2>Browser support</h2><span class="hint">what this browser can actually decode and decrypt</span></div>
      <div id="capabilities"><span class="muted">probing…</span></div>
    </section>

    <section class="panel tab-panel" data-panel="composition" hidden>
      <div class="panel-head"><h2>Composition</h2><span class="hint">Pick a preset, the same compositions the package ships, or go custom and tick modules; dependencies pull themselves in.</span></div>
      <div class="controls">
        <label class="tp-stat" title="A preset composes exactly the stages the package's preset of that name does. Custom unlocks the table below.">
          <span class="tp-k">preset</span>
          <select id="presetSelect" class="tp-select"></select>
        </label>
      </div>
      <div id="stages"></div>
    </section>

    <section class="panel tab-panel" data-panel="network" hidden>
      <div class="panel-head"><h2>Network faults</h2><span class="hint">inject failures through the transport seam</span></div>
      <div id="network"></div>
    </section>

    <section class="panel tab-panel" data-panel="manifest" hidden>
      <div class="panel-head"><h2>Manifest</h2><span class="hint">every manifest the engine fetched for this stream, ready to inspect; edit the text and parse it again</span></div>
      <div class="controls">
        <select id="manifestPick" class="grow"><option value="">no manifest fetched yet</option></select>
        <label class="chk" title="Keep the text current as live playlists refresh"><input type="checkbox" id="manifestFollow" checked><span>follow refreshes</span></label>
        <button id="parseText" class="primary">Parse</button>
      </div>
      <div id="manifestMeta" class="muted mono"></div>
      <div id="manifestChecks" class="checks"></div>
      <textarea id="manifestText" rows="14" placeholder="paste manifest text here, or load a stream to see its manifests…"></textarea>
      <details class="parsed">
        <summary>Parsed structure</summary>
        <pre id="parseOut" class="mono muted scroll"></pre>
      </details>
    </section>
  </main>
`;
(document.querySelector('#player') as HTMLElement).appendChild(video);
// The scrub bar reads the element for time and the engine for the live edge
// and the wall clock, which is the one thing the native bar cannot show.
const transport = createTransportBar(document.querySelector('#transport') as HTMLElement, {
  video,
  card: document.querySelector('#player') as HTMLElement,
  engine: () => engine,
});
bindThemeToggle(document.querySelector('#themeToggle') as HTMLElement);

// ---- tabs ----------------------------------------------------------------

const TAB_KEY = 'mattebox.playground.tab';

function showTab(name: string): void {
  for (const button of document.querySelectorAll<HTMLElement>('#tabs [data-tab]')) {
    const on = button.dataset.tab === name;
    button.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]')) {
    panel.hidden = panel.dataset.panel !== name;
  }
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch {
    // Storage may be unavailable; the tab still switches.
  }
}
for (const button of document.querySelectorAll<HTMLElement>('#tabs [data-tab]')) {
  button.addEventListener('click', () => showTab(button.dataset.tab as string));
}
{
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(TAB_KEY);
  } catch {
    saved = null;
  }
  showTab(saved !== null && document.querySelector(`[data-panel="${saved}"]`) ? saved : 'stream');
}

// ---- pinned deck: transport, status, and tabs stay in reach when scrolled ----

{
  const pinned = document.querySelector('#pinned') as HTMLElement;
  const slot = document.querySelector('#playerSlot') as HTMLElement;
  // Stuck once the picture has scrolled out: a shadow says so, and a way
  // back appears in the tab strip.
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (entry !== undefined) pinned.classList.toggle('stuck', !entry.isIntersecting);
    },
    { threshold: 0 },
  );
  observer.observe(slot);
  (document.querySelector('#backToPlayer') as HTMLElement).addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ---- thumbnails: load the track; the scrub tooltip shows the tiles ----------

type ThumbnailsApi = {
  load(url: string): Promise<number>;
};

function thumbnailsApi(): ThumbnailsApi | null {
  return (engine as { thumbnails?: ThumbnailsApi } | null)?.thumbnails ?? null;
}

async function loadThumbnails(): Promise<void> {
  const pill = document.querySelector('#thumbState') as HTMLElement;
  const api = thumbnailsApi();
  if (config.thumbnails === undefined || api === null) {
    pill.className = 'pill';
    pill.textContent =
      api === null && config.thumbnails !== undefined ? 'thumbnails stage off' : 'no thumbnails';
    return;
  }
  pill.className = 'pill wait';
  pill.textContent = 'loading thumbnails…';
  try {
    const count = await api.load(config.thumbnails);
    pill.className = count > 0 ? 'pill ok' : 'pill bad';
    pill.textContent = `${count} thumbnail${count === 1 ? '' : 's'} · hover the seek bar`;
  } catch (error) {
    pill.className = 'pill bad';
    pill.textContent = `thumbnails failed: ${String((error as Error).message)}`;
  }
}

// ---- manifest capture: what the engine fetched, for the inspector ----------

interface CapturedManifest {
  readonly url: string;
  text: string;
  fetchedAt: number;
  count: number;
}
const manifests = new Map<string, CapturedManifest>();
let manifestOptionsSignature = '';

function isManifestUrl(url: string): boolean {
  if (url === config.stream) return true;
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith('.m3u8') || path.endsWith('.mpd');
  } catch {
    return false;
  }
}

/** One entry per playlist: the cmcd stage varies the query string per request. */
function manifestKey(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('CMCD');
    return u.href;
  } catch {
    return url;
  }
}

function captureManifest(url: string, text: string): void {
  const key = manifestKey(url);
  const existing = manifests.get(key);
  if (existing !== undefined) {
    existing.text = text;
    existing.fetchedAt = Date.now();
    existing.count += 1;
  } else {
    manifests.set(key, { url: key, text, fetchedAt: Date.now(), count: 1 });
  }
  renderManifestPicker();
}

function manifestLabel(m: CapturedManifest): string {
  const path = (() => {
    try {
      return new URL(m.url).pathname.split('/').slice(-2).join('/');
    } catch {
      return m.url;
    }
  })();
  const kind =
    m.url === config.stream
      ? 'master'
      : m.text.includes('#EXT-X-STREAM-INF')
        ? 'master'
        : m.text.trimStart().startsWith('#EXTM3U')
          ? 'media playlist'
          : 'MPD';
  return `${kind} · ${path}${m.count > 1 ? ` · refreshed ×${m.count}` : ''}`;
}

function renderManifestPicker(): void {
  const pick = document.querySelector('#manifestPick') as HTMLSelectElement;
  const text = document.querySelector('#manifestText') as HTMLTextAreaElement;
  const meta = document.querySelector('#manifestMeta') as HTMLElement;
  const follow = (document.querySelector('#manifestFollow') as HTMLInputElement).checked;
  const master = manifestKey(new URL(config.stream, location.href).href);
  const list = [...manifests.values()].sort((a, b) => {
    if (a.url === master) return -1;
    if (b.url === master) return 1;
    return a.fetchedAt - b.fetchedAt;
  });
  const signature = list.map((m) => `${m.url}|${m.count}`).join('\n');
  if (signature !== manifestOptionsSignature) {
    manifestOptionsSignature = signature;
    const current = pick.value;
    pick.innerHTML = list
      .map((m) => `<option value="${m.url}">${manifestLabel(m)}</option>`)
      .join('');
    pick.value = list.some((m) => m.url === current) ? current : (list[0]?.url ?? '');
  }
  const chosen = manifests.get(pick.value);
  if (chosen === undefined) return;
  meta.textContent = `${chosen.url} · ${chosen.text.length} chars · fetched ${new Date(
    chosen.fetchedAt,
  ).toLocaleTimeString()}`;
  if (follow || text.value === '') {
    if (text.value !== chosen.text) {
      text.value = chosen.text;
      void inspectManifest();
    }
  }
}

(document.querySelector('#manifestPick') as HTMLSelectElement).addEventListener('change', () => {
  (document.querySelector('#manifestText') as HTMLTextAreaElement).value = '';
  renderManifestPicker();
});
(document.querySelector('#manifestText') as HTMLTextAreaElement).addEventListener('input', () => {
  // Editing by hand turns following off, so a live refresh cannot undo the edit.
  (document.querySelector('#manifestFollow') as HTMLInputElement).checked = false;
});

// ---- stages panel --------------------------------------------------------

/** The preset whose stage set equals the composition, or null for custom. */
function matchPreset(stages: readonly string[]): string | null {
  const built = new Set(stages.filter((n) => CATALOGUE.some((e) => e.name === n && e.factory)));
  const hit = PRESETS.find(
    (p) => p.stages.length === built.size && p.stages.every((n) => built.has(n)),
  );
  return hit?.name ?? null;
}

function renderStages(): void {
  const host = document.querySelector('#stages') as HTMLElement;
  const presetSelect = document.querySelector('#presetSelect') as HTMLSelectElement;
  const current = config.custom === true ? null : matchPreset(config.stages);
  const custom = current === null;
  presetSelect.replaceChildren(
    ...PRESETS.map((p) => new Option(p.name, p.name, false, p.name === current)),
    new Option('custom', 'custom', false, custom),
  );
  presetSelect.onchange = () => {
    const chosen = PRESETS.find((p) => p.name === presetSelect.value);
    if (chosen === undefined) {
      // Custom keeps the current stages; the table opens for editing.
      config.custom = true;
      renderStages();
      return;
    }
    config.custom = false;
    config.stages = chosen.stages.filter((n) => CATALOGUE.some((e) => e.name === n && e.factory));
    void rebuild();
    renderStages();
  };
  const layers: Array<[CatalogueEntry['layer'], string, string]> = [
    ['protocols', 'Protocols', 'manifest formats the engine understands'],
    ['containers', 'Containers', 'how media bytes become SourceBuffer appends'],
    ['stages', 'Stages', 'everything else: ABR, text, DRM, recovery, telemetry'],
  ];
  const rows = layers
    .map(([layer, title, note]) => {
      const entries = CATALOGUE.filter((e) => e.layer === layer);
      const on = entries.filter((e) => e.factory !== null && config.stages.includes(e.name));
      const head = `<tr class="layer-row"><th colspan="4">${title} <span class="muted">${note}, ${on.length} of ${
        entries.filter((e) => e.factory !== null).length
      } on</span></th></tr>`;
      const body = entries
        .map((entry) => {
          const built = entry.factory !== null;
          const checked = config.stages.includes(entry.name);
          const requires = entry.requires.map((r) => {
            const dep = CATALOGUE.find((e) => e.name === r);
            const satisfied = dep === undefined || config.stages.includes(r);
            return `<span class="req ${satisfied ? '' : 'missing'}" title="${
              dep === undefined ? 'provided by the kernel' : satisfied ? 'on' : 'off'
            }">${r}</span>`;
          });
          return `<tr class="${built ? '' : 'unbuilt'}">
            <td><input type="checkbox" data-stage="${entry.name}" ${checked ? 'checked' : ''} ${built && custom ? '' : 'disabled'}></td>
            <td class="stage-name">${entry.name}</td>
            <td>${requires.join(' ') || '<span class="muted">nothing</span>'}</td>
            <td class="muted">${built ? (checked ? 'on' : 'off') : 'not built yet'}</td>
          </tr>`;
        })
        .join('');
      return head + body;
    })
    .join('');
  host.innerHTML = `<div class="table-wrap"><table class="table stages-table">
    <thead><tr><th></th><th>Module</th><th>Needs</th><th>State</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
  for (const box of host.querySelectorAll<HTMLInputElement>('[data-stage]')) {
    box.addEventListener('change', () => {
      const name = box.dataset.stage as string;
      const entry = CATALOGUE.find((e) => e.name === name);
      if (entry === undefined) return;
      config.stages = box.checked
        ? [...config.stages, name]
        : config.stages.filter((n) => n !== name);
      // Dependencies pull themselves in; nothing pulls a dependent out.
      for (const req of entry.requires) {
        const dep = CATALOGUE.find((e) => e.name === req);
        if (box.checked && dep?.factory != null && !config.stages.includes(req)) {
          config.stages.push(req);
        }
      }
      void rebuild();
      renderStages();
    });
  }
  const summary = document.querySelector('#compositionSummary') as HTMLElement;
  const count = config.stages.filter((n) =>
    CATALOGUE.some((e) => e.name === n && e.factory),
  ).length;
  summary.textContent =
    current === null ? `custom, ${count} stages` : `${current}, ${count} stages`;
}

// ---- streams -------------------------------------------------------------

function renderStreams(): void {
  const select = document.querySelector('#streamSelect') as HTMLSelectElement;
  if (select.options.length === 0) {
    for (const stream of STREAMS) {
      const option = document.createElement('option');
      option.value = stream.url;
      option.textContent = stream.label;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      const entry = STREAMS.find((s) => s.url === select.value);
      if (entry === undefined) return;
      applyStreamChoice({
        url: entry.url,
        ...(entry.licenseUrl !== undefined ? { licenseUrl: entry.licenseUrl } : {}),
        ...(entry.keySystem !== undefined ? { keySystem: entry.keySystem } : {}),
        ...(entry.thumbnails !== undefined ? { thumbnails: entry.thumbnails } : {}),
      });
    });
  }
  const match = STREAMS.find((s) => s.url === config.stream);
  select.value = match ? config.stream : '';
  reflectStreamInputs();
}

/** Mirrors the config into the URL, license, and key-system inputs. */
function reflectStreamInputs(): void {
  (document.querySelector('#thumbUrl') as HTMLInputElement).value = config.thumbnails ?? '';
  (document.querySelector('#streamUrl') as HTMLInputElement).value = config.stream;
  (document.querySelector('#licenseUrl') as HTMLInputElement).value = config.licenseUrl ?? '';
  (document.querySelector('#keySystem') as HTMLSelectElement).value = config.keySystem ?? '';
}

/**
 * One door for every way of choosing a stream: the demo list, a pasted
 * URL, or an SRG SSR resource. Whatever is not given is cleared, so a
 * license from the previous stream never leaks into the next.
 */
function applyStreamChoice(choice: {
  url: string;
  licenseUrl?: string;
  keySystem?: string;
  licenseUrls?: Record<string, string>;
  certificateUrl?: string;
  srgTitle?: string;
  thumbnails?: string;
}): void {
  config.stream = choice.url;
  delete config.licenseUrl;
  delete config.keySystem;
  delete config.licenseUrls;
  delete config.certificateUrl;
  delete config.srgTitle;
  delete config.thumbnails;
  if (choice.thumbnails !== undefined) config.thumbnails = choice.thumbnails;
  if (choice.licenseUrl !== undefined) config.licenseUrl = choice.licenseUrl;
  if (choice.keySystem !== undefined) config.keySystem = choice.keySystem;
  if (choice.licenseUrls !== undefined) config.licenseUrls = choice.licenseUrls;
  if (choice.certificateUrl !== undefined) config.certificateUrl = choice.certificateUrl;
  if (choice.srgTitle !== undefined) config.srgTitle = choice.srgTitle;
  reflectStreamInputs();
  void rebuild();
}

(document.querySelector('#loadUrl') as HTMLElement).addEventListener('click', () => {
  const url = (document.querySelector('#streamUrl') as HTMLInputElement).value.trim();
  const license = (document.querySelector('#licenseUrl') as HTMLInputElement).value.trim();
  const keySystem = (document.querySelector('#keySystem') as HTMLSelectElement).value;
  const thumbs = (document.querySelector('#thumbUrl') as HTMLInputElement).value.trim();
  if (url === '') return;
  // A hand-edited URL keeps the SRG license set only while the URL is unchanged.
  const keepIl = url === config.stream;
  applyStreamChoice({
    url,
    ...(license !== '' ? { licenseUrl: license } : {}),
    ...(keySystem !== '' ? { keySystem } : {}),
    ...(keepIl && config.licenseUrls !== undefined ? { licenseUrls: config.licenseUrls } : {}),
    ...(keepIl && config.certificateUrl !== undefined
      ? { certificateUrl: config.certificateUrl }
      : {}),
    ...(keepIl && config.srgTitle !== undefined ? { srgTitle: config.srgTitle } : {}),
    ...(thumbs !== '' ? { thumbnails: thumbs } : {}),
  });
});
(document.querySelector('#licenseUrl') as HTMLInputElement).addEventListener('change', (e) => {
  const value = (e.target as HTMLInputElement).value.trim();
  if (value === '') delete config.licenseUrl;
  else config.licenseUrl = value;
});
(document.querySelector('#keySystem') as HTMLSelectElement).addEventListener('change', (e) => {
  const value = (e.target as HTMLSelectElement).value;
  if (value === '') delete config.keySystem;
  else config.keySystem = value;
});

// ---- SRG SSR: search, resolve, pick a resource --------------------------------

{
  const bu = document.querySelector('#srgBu') as HTMLSelectElement;
  const query = document.querySelector('#srgQuery') as HTMLInputElement;
  const go = document.querySelector('#srgGo') as HTMLElement;
  const state = document.querySelector('#srgState') as HTMLElement;
  const results = document.querySelector('#srgResults') as HTMLElement;
  const composition = document.querySelector('#srgComposition') as HTMLElement;
  bu.innerHTML = BUSINESS_UNITS.map(
    (unit) =>
      `<option value="${unit}"${unit === 'rts' ? ' selected' : ''}>${unit.toUpperCase()}</option>`,
  ).join('');
  let debounce = 0;
  let inflight: AbortController | null = null;

  function setState(text: string, level: '' | 'bad' = ''): void {
    state.textContent = text;
    state.className = level === 'bad' ? 'pill bad' : 'muted';
  }

  function renderResults(list: SearchResult[]): void {
    results.hidden = list.length === 0;
    results.innerHTML = list
      .map(
        (r) => `<button class="srg-result" data-urn="${r.urn}">
          <span class="srg-title">${r.title}</span>
          <span class="srg-meta">${r.mediaType.toLowerCase()}${
            r.duration ? `, ${fmtDuration(r.duration)}` : ''
          }${r.date ? `, ${new Date(r.date).toLocaleDateString()}` : ''}</span>
        </button>`,
      )
      .join('');
    for (const el of results.querySelectorAll<HTMLElement>('[data-urn]')) {
      el.addEventListener('click', () => void resolve(el.dataset.urn as string));
    }
  }

  function describeResource(r: IlResource): string {
    const parts = [r.streaming, r.quality, r.presentation];
    if (r.mediaContainer) parts.push(r.mediaContainer);
    if (r.live) parts.push(r.dvr ? 'live, DVR' : 'live');
    return parts.filter((s) => s).join(', ');
  }

  function renderComposition(c: Composition): void {
    composition.hidden = false;
    const rows = c.resources
      .map((r, i) => {
        const drm = (r.drmList ?? []).map((d) => d.type.toLowerCase()).join(', ');
        return `<tr>
          <td>${describeResource(r)}</td>
          <td>${drm !== '' ? `<span class="pill">${drm}</span>` : '<span class="muted">clear</span>'}</td>
          <td>${r.tokenType === 'AKAMAI' ? '<span class="pill">akamai token</span>' : '<span class="muted">none</span>'}</td>
          <td class="wrap"><span class="muted">${r.url}</span></td>
          <td>${
            r.streaming === 'HLS' || r.streaming === 'DASH'
              ? `<button class="small primary" data-resource="${i}">Play</button>`
              : '<span class="muted" title="The engine plays HLS and DASH; a progressive file needs no engine">not adaptive</span>'
          }</td>
        </tr>`;
      })
      .join('');
    composition.innerHTML = `
      <div class="srg-head">
        ${c.imageUrl ? `<img class="srg-thumb" alt="" src="${c.imageUrl}?width=240&format=jpg">` : ''}
        <div>
          <div class="srg-name">${c.title}</div>
          <div class="muted">${c.vendor} · ${c.mediaType.toLowerCase()} · ${c.urn}</div>
          ${c.blockReason ? `<div class="pill bad">blocked: ${c.blockReason}</div>` : ''}
        </div>
      </div>
      ${
        c.resources.length === 0
          ? '<p class="muted">This media has no playable resource.</p>'
          : `<div class="table-wrap"><table class="table">
              <thead><tr><th>Resource</th><th>DRM</th><th>Token</th><th>URL</th><th></th></tr></thead>
              <tbody>${rows}</tbody></table></div>`
      }`;
    for (const el of composition.querySelectorAll<HTMLElement>('[data-resource]')) {
      el.addEventListener('click', () => {
        const resource = c.resources[Number(el.dataset.resource)];
        if (resource !== undefined) void play(c, resource);
      });
    }
  }

  async function play(c: Composition, resource: IlResource): Promise<void> {
    setState('preparing…');
    try {
      const url = resource.tokenType === 'AKAMAI' ? await tokenize(resource.url) : resource.url;
      const licenseUrls = licenseUrlsFor(resource);
      const certificateUrl = certificateUrlFor(resource);
      applyStreamChoice({
        url,
        ...(Object.keys(licenseUrls).length > 0 ? { licenseUrls } : {}),
        ...(certificateUrl !== undefined ? { certificateUrl } : {}),
        srgTitle: c.title,
      });
      (document.querySelector('#streamSelect') as HTMLSelectElement).value = '';
      setState(`playing ${c.title}`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      setState(`could not prepare the stream: ${String((error as Error).message)}`, 'bad');
    }
  }

  async function resolve(urn: string): Promise<void> {
    results.hidden = true;
    setState('resolving…');
    inflight?.abort();
    inflight = new AbortController();
    try {
      const c = await fetchComposition(urn, inflight.signal);
      renderComposition(c);
      setState(`${c.resources.length} resource(s)`);
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      composition.hidden = true;
      setState(`could not resolve ${urn}: ${String((error as Error).message)}`, 'bad');
    }
  }

  async function search(text: string): Promise<void> {
    inflight?.abort();
    inflight = new AbortController();
    setState('searching…');
    try {
      const list = await searchMedia(bu.value as BusinessUnit, text, inflight.signal);
      renderResults(list);
      setState(list.length === 0 ? 'no results' : `${list.length} result(s)`);
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setState(`search failed: ${String((error as Error).message)}`, 'bad');
    }
  }

  function submit(): void {
    const text = query.value.trim();
    if (text === '') return;
    if (text.startsWith('urn:')) void resolve(text);
    else void search(text);
  }

  query.addEventListener('input', () => {
    clearTimeout(debounce);
    const text = query.value.trim();
    if (text === '' || text.startsWith('urn:')) {
      results.hidden = true;
      return;
    }
    debounce = window.setTimeout(() => void search(text), 300);
  });
  query.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounce);
      submit();
    }
  });
  go.addEventListener('click', submit);
  bu.addEventListener('change', () => {
    if (query.value.trim() !== '' && !query.value.trim().startsWith('urn:')) submit();
  });
}

function parseManifestText(text: string, baseUrl: string): ParsedManifest {
  const body = text.trimStart();
  if (body.startsWith('<') || body.includes('<MPD')) {
    const parsed = parseDash(text, baseUrl);
    return { kind: 'dash', presentation: parsed.presentation, error: parsed.error };
  }
  if (body.includes('#EXT-X-STREAM-INF')) {
    const parsed = parse(text, baseUrl);
    return { kind: 'hls-master', presentation: parsed.presentation, error: parsed.error };
  }
  const parsed = parseMediaPlaylist(text, baseUrl);
  return { kind: 'hls-media', playlist: parsed.playlist, error: parsed.error };
}

let checksRun = 0;

function renderChecks(host: HTMLElement, checks: readonly Check[]): void {
  const counts = { error: 0, warn: 0, info: 0, ok: 0 };
  for (const c of checks) counts[c.level] += 1;
  const summary =
    counts.error + counts.warn === 0
      ? 'No problems found.'
      : `${counts.error} problem${counts.error === 1 ? '' : 's'}, ${counts.warn} warning${
          counts.warn === 1 ? '' : 's'
        }.`;
  host.innerHTML = `<div class="checks-summary">${summary}</div>${checks
    .map(
      (c) =>
        `<div class="check check-${c.level}"><span class="check-dot"></span><div><div>${c.message}</div>${
          c.hint !== undefined ? `<div class="check-hint">${c.hint}</div>` : ''
        }</div></div>`,
    )
    .join('')}`;
}

async function inspectManifest(): Promise<void> {
  const text = (document.querySelector('#manifestText') as HTMLTextAreaElement).value;
  const out = document.querySelector('#parseOut') as HTMLElement;
  const host = document.querySelector('#manifestChecks') as HTMLElement;
  if (text.trim() === '') {
    host.innerHTML = '';
    out.textContent = '';
    return;
  }
  const baseUrl =
    (document.querySelector('#manifestPick') as HTMLSelectElement).value ||
    'https://pasted.example/master.m3u8';
  const parsed = parseManifestText(text, baseUrl);
  out.textContent = toJson(
    parsed.error ?? (parsed.kind === 'hls-media' ? parsed.playlist : parsed.presentation),
  );
  const run = ++checksRun;
  const checks = await checkManifest(text, parsed);
  if (run === checksRun) renderChecks(host, checks);
}

(document.querySelector('#parseText') as HTMLElement).addEventListener('click', () => {
  void inspectManifest();
});
(document.querySelector('#share') as HTMLElement).addEventListener('click', () => {
  const url = shareUrl();
  history.replaceState(null, '', url);
  void navigator.clipboard?.writeText(url);
  (document.querySelector('#shared') as HTMLElement).textContent = 'copied';
});

// ---- network panel -------------------------------------------------------

function renderNetwork(): void {
  const host = document.querySelector('#network') as HTMLElement;
  // Three groups, one per kind of fault, so a reader sees what belongs
  // together: the shape of the link, the failures it returns, and the
  // requests that never come back.
  host.innerHTML = `
    <div class="faults">
      <fieldset class="fault-group">
        <legend>Throughput</legend>
        <label class="field"><span>profile</span><select id="nProfile">
          <option value="none">none</option><option value="step-down">step down</option>
          <option value="sawtooth">sawtooth</option><option value="collapse-recover">collapse + recover</option>
        </select></label>
        <label class="field"><span>bandwidth cap</span><span class="unit"><input id="nBps" type="number" value="0" min="0"> bps</span></label>
        <label class="field"><span>added latency</span><span class="unit"><input id="nLat" type="number" value="0" min="0"> ms</span></label>
        <p class="field-hint">A profile overrides the cap while it runs. 0 turns a cap off.</p>
      </fieldset>
      <fieldset class="fault-group">
        <legend>Failures</legend>
        <label class="field"><span>HTTP status</span><input id="nStatus" type="number" value="503"></label>
        <label class="field"><span>every Nth request</span><input id="nNth" type="number" value="0" min="0"></label>
        <label class="field"><span>URL contains</span><input id="nMatch" placeholder="any"></label>
        <p class="field-hint">0 turns forcing off. The match narrows it to segments, playlists, or one rendition.</p>
      </fieldset>
      <fieldset class="fault-group">
        <legend>Stalls</legend>
        <label class="chk"><input type="checkbox" id="nStall"><span>stall segments: accept the request, never respond</span></label>
        <label class="chk"><input type="checkbox" id="nManifest"><span>fail manifest refreshes</span></label>
        <p class="field-hint">Stalls exercise the transport timeout and the recovery stage; failed refreshes exercise the live adapters.</p>
      </fieldset>
    </div>
    <div class="controls">
      <button id="nApply" class="primary">Apply and rebuild</button>
      <span class="hint">the engine is rebuilt with the faults in its transport; a profile runs from the load</span>
    </div>
  `;
  (host.querySelector('#nApply') as HTMLElement).addEventListener('click', () => {
    faults.profile = (host.querySelector('#nProfile') as HTMLSelectElement)
      .value as FaultConfig['profile'];
    faults.bandwidthBps = Number((host.querySelector('#nBps') as HTMLInputElement).value) || 0;
    faults.latencyMs = Number((host.querySelector('#nLat') as HTMLInputElement).value) || 0;
    faults.forceStatus = Number((host.querySelector('#nStatus') as HTMLInputElement).value) || 503;
    faults.forceEveryNth = Number((host.querySelector('#nNth') as HTMLInputElement).value) || 0;
    faults.match = (host.querySelector('#nMatch') as HTMLInputElement).value;
    faults.stall = (host.querySelector('#nStall') as HTMLInputElement).checked;
    faults.failManifests = (host.querySelector('#nManifest') as HTMLInputElement).checked;
    void rebuild();
  });
}

// ---- event log -------------------------------------------------------------

const log = createEventLog(document.querySelector('#log') as HTMLElement);

function readLogFilter(): void {
  const levels = new Set<Level>();
  for (const [id, level] of [
    ['#lvlError', 'error'],
    ['#lvlWarn', 'warn'],
    ['#lvlInfo', 'info'],
    ['#lvlDebug', 'debug'],
  ] as const) {
    if ((document.querySelector(id) as HTMLInputElement).checked) levels.add(level);
  }
  log.setFilter({
    text: (document.querySelector('#logFilter') as HTMLInputElement).value,
    levels,
    source: (document.querySelector('#logSource') as HTMLSelectElement).value as Source | 'all',
  });
}
for (const id of ['#logFilter', '#logSource', '#lvlError', '#lvlWarn', '#lvlInfo', '#lvlDebug']) {
  (document.querySelector(id) as HTMLElement).addEventListener('input', readLogFilter);
}
(document.querySelector('#clearLog') as HTMLElement).addEventListener('click', () => log.clear());

(document.querySelector('#replayBtn') as HTMLElement).addEventListener('click', () => {
  if (engine === null) return;
  const out = document.querySelector('#replayOut') as HTMLElement;
  const entries: readonly TraceEntry[] = engine.stats.trace();
  const selected = log.selectedTrace();
  const index = selected === null ? -1 : entries.indexOf(selected);
  const end = index >= 0 ? index + 1 : entries.length;
  const result = replay(entries.slice(0, end), composedReducer(), initialState());
  out.className = `pill ${result.ok ? 'ok' : 'bad'}`;
  out.textContent = result.ok
    ? `replay of ${end}: effects match`
    : `diverged at #${result.divergedAt}`;
});

function download(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * A presentation in the trace is the whole DVR window, thousands of segment
 * objects, repeated on every playlist refresh. The report keeps counts and
 * edges, which is what a diagnosis reads, and drops the rest.
 */
function slimPresentation(p: Presentation): unknown {
  return {
    id: p.id,
    isLive: p.isLive,
    duration: p.duration,
    periods: p.periods.map((period) => ({
      id: period.id,
      start: period.start,
      tracks: period.tracks.map((t) => ({
        id: t.id,
        contentType: t.contentType,
        protection: t.protection !== null ? t.protection.schemes.length : 0,
        renditions: t.renditions.map((r) => ({
          id: r.id,
          bitrate: r.bitrate,
          height: r.height,
          codecs: r.codecs,
          init: r.init?.url,
          segments: Array.isArray(r.segments)
            ? {
                count: r.segments.length,
                first: r.segments[0] && { seq: r.segments[0].seq, start: r.segments[0].start },
                last: r.segments[r.segments.length - 1] && {
                  seq: (r.segments[r.segments.length - 1] as { seq: number }).seq,
                  end:
                    (r.segments[r.segments.length - 1] as { start: number; duration: number })
                      .start + (r.segments[r.segments.length - 1] as { duration: number }).duration,
                },
              }
            : r.segments,
        })),
      })),
    })),
  };
}

function slimMessage(msg: Record<string, unknown> & { type: string }): unknown {
  if (msg.type === 'MANIFEST_LOADED') {
    return { type: msg.type, presentation: slimPresentation(msg.presentation as Presentation) };
  }
  if (msg.type === 'PLAYLIST_REFRESHED') {
    const segments = msg.segments as ReadonlyArray<{
      seq: number;
      start: number;
      duration: number;
    }>;
    const last = segments[segments.length - 1];
    return {
      ...msg,
      segments: {
        count: segments.length,
        first: segments[0],
        last: last === undefined ? undefined : { seq: last.seq, end: last.start + last.duration },
      },
    };
  }
  if (msg.type === 'SEGMENT_LOADED') {
    return { ...msg, bytes: `ArrayBuffer(${(msg.bytes as ArrayBuffer).byteLength})` };
  }
  return msg;
}

function slimTrace(entries: readonly TraceEntry[]): unknown[] {
  return entries.map((e) => {
    const effects = e.effects.map((fx) => {
      const f = fx as Record<string, unknown> & { kind: string };
      if (f.kind === 'append' || f.kind === 'deliver') {
        return { ...f, data: `ArrayBuffer(${(f.data as ArrayBuffer).byteLength})` };
      }
      if (f.kind === 'emit' && f.event === 'tracks:changed')
        return { kind: 'emit', event: f.event };
      if (f.kind === 'schedule') {
        // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name
        return { ...f, then: slimMessage(f.then as Record<string, unknown> & { type: string }) };
      }
      return f;
    });
    return {
      t: e.t,
      digest: e.digest,
      msg: slimMessage(e.msg as Record<string, unknown> & { type: string }),
      effects,
    };
  });
}

(document.querySelector('#reportBtn') as HTMLElement).addEventListener('click', () => {
  if (engine === null) return;
  const state = engine.stats.snapshot();
  const report = {
    at: new Date().toISOString(),
    // Trace and log times are performance.now() values; add this to get
    // epoch milliseconds and line them up with chrome://media-internals.
    timeOrigin: performance.timeOrigin,
    now: performance.now(),
    userAgent: navigator.userAgent,
    stream: config.stream,
    config: { ...config, licenseUrls: config.licenseUrls, stages: config.stages },
    mediaError:
      video.error !== null ? { code: video.error.code, message: video.error.message } : null,
    element: {
      currentTime: video.currentTime,
      readyState: video.readyState,
      buffered: Array.from({ length: video.buffered.length }, (_, i) => [
        video.buffered.start(i),
        video.buffered.end(i),
      ]),
      quality: video.getVideoPlaybackQuality?.() ?? null,
    },
    engine: {
      phase: state.lifecycle.phase,
      error: engine.error === null ? null : { ...engine.error, trace: undefined },
      live: state.live,
      playing: engine.quality.playing?.id ?? null,
      active: state.quality.active,
      appendLog: state.quality.appendLog,
      buffers: [...state.buffers.entries()],
      renditions: engine.quality.renditions.map((r) => ({
        id: r.id,
        bitrate: r.bitrate,
        width: r.width,
        height: r.height,
        codecs: r.codecs,
      })),
    },
    log: log.entries().map((e) => ({
      t: e.t,
      level: e.level,
      source: e.source,
      type: e.type,
      message: e.message,
      effects: e.effects,
    })),
    trace: slimTrace(engine.stats.trace()),
  };
  download(`mattebox-report-${Date.now()}.json`, toJson(report, 0));
});

(document.querySelector('#exportBtn') as HTMLElement).addEventListener('click', () => {
  if (engine === null) return;
  const blob = new Blob([toJson(engine.stats.trace())], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'mattebox-trace.json';
  link.click();
  URL.revokeObjectURL(link.href);
});

// ---- timeline charts -------------------------------------------------------

const charts = createCharts(document.querySelector('#charts') as HTMLElement, {
  engine: () => engine,
  video,
});

// ---- engine table ----------------------------------------------------------

function renderEngineInfo(): void {
  const host = document.querySelector('#engineInfo') as HTMLElement | null;
  if (host === null || engine === null || host.offsetParent === null) return;
  const state = engine.stats.snapshot();
  const quality = video.getVideoPlaybackQuality?.();
  const live = (engine as { live?: { latency: number | null; atEdge: boolean } }).live;
  const buffered: string[] = [];
  for (let i = 0; i < video.buffered.length; i += 1) {
    buffered.push(`${video.buffered.start(i).toFixed(1)}–${video.buffered.end(i).toFixed(1)}`);
  }
  const rows: Array<[string, string]> = [
    ['phase', state.lifecycle.phase],
    [
      'element',
      `readyState ${video.readyState} · networkState ${video.networkState} · ${video.paused ? 'paused' : 'playing'} · rate ${video.playbackRate}`,
    ],
    [
      'time',
      `${video.currentTime.toFixed(2)} / ${Number.isFinite(video.duration) ? video.duration.toFixed(2) : '∞'}`,
    ],
    ['buffered', buffered.join(', ') || 'empty'],
    ['buffer goal', `${state.scheduling.bufferGoal}s`],
    [
      'throughput',
      `slow ${fmtBitrate(state.stats.throughputEwma)} · fast ${fmtBitrate(state.stats.throughputFastEwma)}`,
    ],
    [
      'inflight',
      [...state.scheduling.inflight.values()].map((r) => `${r.trackId} #${r.seq}`).join(', ') ||
        '—',
    ],
    [
      'source buffers',
      [...state.buffers.entries()].map(([id, b]) => `${id} (${b.codecs})`).join(', ') || '—',
    ],
    [
      'live',
      state.live !== null
        ? `window ${state.live.span.start.toFixed(1)}–${state.live.span.end.toFixed(1)} · edge ${state.live.edge.toFixed(1)}${live?.latency != null ? ` · ${live.latency.toFixed(1)}s behind` : ''}`
        : 'VOD',
    ],
    [
      'frames',
      quality !== undefined
        ? `${quality.totalVideoFrames} decoded · ${quality.droppedVideoFrames} dropped${quality.totalVideoFrames > 0 ? ` (${((100 * quality.droppedVideoFrames) / quality.totalVideoFrames).toFixed(2)}%)` : ''}`
        : 'n/a',
    ],
    [
      'active tracks',
      [...state.tracks.active.entries()].map(([type, id]) => `${type}: ${id}`).join(' · ') || '—',
    ],
    ['capabilities', [...engine.capabilities()].join(', ') || '(none)'],
    ['trace', `${engine.stats.trace().length} entries · ${log.size} log rows`],
  ];
  host.innerHTML = rows
    .map(([k, v]) => `<tr><th>${k}</th><td class="wrap">${v}</td></tr>`)
    .join('');
}

// ---- playback status: the plain-language answer to "what's happening?" ----

const MEDIA_ERR = [
  '',
  'MEDIA_ERR_ABORTED',
  'MEDIA_ERR_NETWORK',
  'MEDIA_ERR_DECODE',
  'MEDIA_ERR_SRC_NOT_SUPPORTED',
];
const stall = { lastTime: -1, since: performance.now() };

function fatalFromTrace(): { type: string; detail: string } | null {
  if (engine === null) return null;
  let fatal: { type: string; detail: string } | null = null;
  for (const entry of engine.stats.trace()) {
    const err = (
      entry.msg as {
        error?: { code?: string; fatal?: boolean; context?: { reason?: string; codecs?: string } };
      }
    ).error;
    if (err !== undefined && err !== null && err.fatal !== false) {
      const extra = err.context?.codecs ?? err.context?.reason ?? '';
      fatal = { type: entry.msg.type, detail: [err.code, extra].filter((s) => s).join(' · ') };
    }
  }
  return fatal;
}

function bufferedAhead(): number {
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (
      video.buffered.start(i) <= video.currentTime + 0.25 &&
      video.buffered.end(i) > video.currentTime
    ) {
      return video.buffered.end(i) - video.currentTime;
    }
  }
  return 0;
}

function drmStatus(): { present: boolean; keySystem: string | null; acquired: boolean } {
  const drm = drmApi();
  const state = engine?.stats.snapshot();
  const present =
    (state?.presentation?.periods ?? []).some((p) =>
      p.tracks.some((t) => (t.protection?.schemes.length ?? 0) > 0),
    ) ?? false;
  return {
    present,
    keySystem: drm?.keySystem ?? null,
    acquired: (drm?.keySystem ?? null) !== null,
  };
}

function renderPlaybackStatus(): void {
  const box = document.querySelector('#playbackStatus') as HTMLElement;
  const text = document.querySelector('#playbackText') as HTMLElement;
  const sub = document.querySelector('#playbackSub') as HTMLElement;
  let level: 'ok' | 'wait' | 'bad' = 'wait';
  let message = 'idle';
  let detail = '';

  const drm = drmStatus();
  const drmPill = document.querySelector('#drmState') as HTMLElement;
  if (drm.present) {
    drmPill.className = `pill ${drm.acquired ? 'ok' : 'wait'}`;
    drmPill.textContent = drm.acquired
      ? `DRM · ${drm.keySystem?.split('.').pop()}`
      : 'DRM · acquiring';
  } else {
    drmPill.className = 'pill';
    drmPill.textContent = 'no DRM';
  }

  if (engine === null) {
    message = 'no engine';
  } else if (video.error !== null) {
    level = 'bad';
    message = 'Playback error';
    detail = `${MEDIA_ERR[video.error.code] ?? `code ${video.error.code}`}${video.error.message ? ` — ${video.error.message}` : ''}`;
  } else {
    const fatal = fatalFromTrace();
    const ahead = bufferedAhead();
    const advancing = video.currentTime > stall.lastTime + 0.01;
    if (advancing) {
      stall.lastTime = video.currentTime;
      stall.since = performance.now();
    }
    const stalledMs = performance.now() - stall.since;

    if (fatal !== null) {
      level = 'bad';
      message = 'Cannot play this stream';
      detail = `${fatal.type}${fatal.detail ? `: ${fatal.detail}` : ''}`;
    } else if (config.stream === '') {
      message = 'Pick a stream to begin';
    } else if (drm.present && !drm.acquired) {
      message = 'Acquiring DRM license…';
      detail = 'negotiating a key system and fetching the license';
    } else if (engine.stats.snapshot().presentation === null) {
      message = 'Loading manifest…';
    } else if (!video.paused && video.readyState >= 3 && ahead > 0.1) {
      level = 'ok';
      message = config.srgTitle !== undefined ? `Playing ${config.srgTitle}` : 'Playing';
      const live = (engine as { live?: { latency: number | null; atEdge: boolean } }).live;
      detail =
        live?.latency != null
          ? `live · ${live.latency.toFixed(0)}s behind edge · ${ahead.toFixed(1)}s buffered`
          : `${video.currentTime.toFixed(1)}s / ${(video.duration || 0).toFixed(0)}s · ${ahead.toFixed(1)}s buffered`;
    } else if (video.paused && video.readyState >= 2) {
      level = 'ok';
      message = 'Ready — press play';
      detail = `${ahead.toFixed(1)}s buffered`;
    } else if (ahead > 0.1 && video.readyState >= 3) {
      level = 'ok';
      message = 'Ready';
    } else if (video.buffered.length === 0 && stalledMs > 6000) {
      level = 'bad';
      message = 'Stalled — no data is arriving';
      detail = 'the first segment never buffered; open Diagnostics to see the last fetch';
    } else if (stalledMs > 4000) {
      level = 'bad';
      message = 'Stalled — buffer is not advancing';
      detail = `${ahead.toFixed(1)}s ahead of the playhead; waiting on the next segment`;
    } else {
      message = 'Buffering…';
      detail =
        video.buffered.length === 0
          ? 'fetching the first segment'
          : `${ahead.toFixed(1)}s buffered`;
    }
  }
  box.className = `pstatus ${level}`;
  text.textContent = message;
  sub.textContent = detail;
}

// ---- boot ----------------------------------------------------------------

function renderStatic(): void {
  renderStages();
  renderStreams();
}

renderNetwork();
renderStatic();
void renderCapabilities(document.querySelector('#capabilities') as HTMLElement);
void rebuild();

Object.assign(window, {
  pg: {
    get engine() {
      return engine;
    },
    config,
    video,
    rebuild,
  },
});

const dockDeps = { engine: () => engine, constraints: config.constraints };
const qualityHost = document.querySelector('#quality') as HTMLElement;
setInterval(() => {
  log.poll();
  charts.poll();
  (document.querySelector('#logCount') as HTMLElement).textContent = `${log.size} rows`;
  renderQuality(qualityHost, dockDeps);
  renderEngineInfo();
  renderPlaybackStatus();
  transport.poll();
}, 500);
(function frame() {
  charts.draw();
  requestAnimationFrame(frame);
})();
