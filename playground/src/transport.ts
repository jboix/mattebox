/**
 * The transport bar under the video, in two rows. The first is transport:
 * play/pause, a scrub bar over the element's seekable range, volume, and
 * the way back to the live edge. The second is about the picture: the
 * viewport and the decoded frame, the audio and subtitle menus, the
 * playback rate, and the display settings. A diagnostic surface, not a
 * player skin: its point is to show where the playhead is in wall clock
 * time on a DVR stream, which the native control bar never does.
 *
 * Time and seeking come from the element, per the element-stays-native
 * rule. The engine supplies only what the element cannot: the live edge and
 * latency (`engine.live`) and the wall clock conversion (`engine.pdt`). A
 * stream without a date anchor shows presentation seconds, so the two cases
 * are visibly different.
 */
import type { Mattebox } from '../../src/index.js';
import { collapseGroups, trackName } from './dock.js';

const CONTROLS_KEY = 'mattebox-playground:native-controls';
const VIEWPORT_KEY = 'mattebox-playground:viewport';
/** Viewport widths on offer. The card keeps 16:9, so the width is the whole choice. */
const VIEWPORTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'fit', label: 'fit width' },
  { value: '1280', label: '1280 × 720' },
  { value: '960', label: '960 × 540' },
  { value: '854', label: '854 × 480' },
  { value: '640', label: '640 × 360' },
  { value: '426', label: '426 × 240' },
];
/** The playback rates offered. The element clamps nothing here; these are the ones worth checking. */
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** The slider resolution: enough for a 2-hour DVR window to seek by the second. */
const STEPS = 10_000;

interface LiveView {
  readonly edge: number | null;
  readonly latency: number | null;
  readonly atEdge: boolean;
  seekToEdge(): void;
}
interface PdtView {
  toWallClock(presentationTime: number): number | null;
}
interface ThumbTile {
  readonly url: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface ThumbnailsView {
  at(time: number): ThumbTile | null;
}
/** The tile's width in the hover card; sprite tiles are scaled to it. */
const THUMB_WIDTH = 160;

export interface TransportDeps {
  readonly video: HTMLVideoElement;
  /** The card around the video; the viewport width lands on it as a CSS variable. */
  readonly card: HTMLElement;
  engine(): Mattebox | null;
}

export interface TransportBar {
  /** Refreshes the bar from the element and the engine. Called on a timer and on element events. */
  poll(): void;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** mm:ss, or h:mm:ss past an hour. */
function fmtPresentation(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Local wall clock, HH:MM:SS. */
function fmtClock(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function createTransportBar(host: HTMLElement, deps: TransportDeps): TransportBar {
  const { video } = deps;
  host.innerHTML = `
    <div class="tp-row tp-main">
      <button id="tpPlay" class="tp-play" type="button" title="Play or pause. Calls the video element's own play() and pause(); the engine follows the element.">▶</button>
      <span id="tpStart" class="tp-time tp-start"></span>
      <div class="tp-scrub">
        <input id="tpScrub" type="range" min="0" max="${STEPS}" value="0" step="1" aria-label="Seek" title="Seek bar across the seekable range. The darker band is media buffered ahead of the playhead; hover to read the time under the cursor.">
        <div id="tpBuffered" class="tp-buffered" aria-hidden="true"></div>
        <div id="tpHover" class="tp-hover" hidden>
          <div id="tpThumb" class="tp-thumb" hidden><div id="tpThumbTile" class="tp-thumb-tile"></div></div>
          <span id="tpHoverTime" class="tp-hover-time"></span>
        </div>
      </div>
      <span id="tpEnd" class="tp-time tp-end"></span>
      <span id="tpNow" class="tp-now"></span>
      <button id="tpLive" class="small go-live" type="button" hidden title="Jump to the live edge (engine.live.seekToEdge). Appears once the playhead has fallen behind it.">Go live</button>
      <button id="tpMute" class="tp-mute" type="button" title="Mute or unmute the video element"></button>
      <input id="tpVolume" type="range" min="0" max="100" value="100" step="1" class="tp-volume" aria-label="Volume" title="Volume of the video element">
    </div>
    <div class="tp-row tp-meta">
      <span class="tp-stat" title="The box the video is drawn in, in CSS pixels. Set by the viewport menu on the right, capped by the width of the column.">
        <span class="tp-k">viewport</span> <span id="tpRendered" class="tp-v"></span>
      </span>
      <span class="tp-stat" title="The frame the engine is decoding right now (the element's videoWidth × videoHeight). It follows the rendition the engine picked, so it moves as the adaptive logic switches.">
        <span class="tp-k">frame</span> <span id="tpFrame" class="tp-v">—</span>
      </span>
      <span id="tpScale" class="tp-stat tp-scale" title="How the frame relates to the viewport: a frame larger than the box is downscaled, a smaller one upscaled."></span>
      <span class="tp-tracks" id="tpTracks" hidden>
        <label class="tp-stat" id="tpAudioWrap" hidden title="Audio track (engine.tracks.select). One entry per language; the engine keeps it within the audio group the video rendition requires.">
          <span class="tp-k">audio</span>
          <select id="tpAudio" class="tp-select" aria-label="Audio track"></select>
        </label>
        <label class="tp-stat" id="tpTextWrap" hidden title="Subtitle track (engine.tracks.select). The same list the browser's caption menu shows; either place drives the other.">
          <span class="tp-k">subtitles</span>
          <select id="tpText" class="tp-select" aria-label="Subtitle track"></select>
        </label>
      </span>
      <label class="tp-stat" title="Playback rate (the element's playbackRate). The engine fetches by buffer time, so a faster rate just drains it sooner.">
        <span class="tp-k">speed</span>
        <select id="tpRate" class="tp-select" aria-label="Playback rate">
          ${RATES.map((r) => `<option value="${r}"${r === 1 ? ' selected' : ''}>${r}×</option>`).join('')}
        </select>
      </label>
      <span class="tp-display">
        <label class="tp-native" title="Swap this bar for the browser's own control bar. Useful to compare what the element does on its own."><input id="tpNativeToggle" type="checkbox"> native controls</label>
        <select id="tpViewport" class="tp-viewport tp-select" title="How large the player is drawn on the page. The number is the width; the card stays 16:9 and other aspect ratios letterbox inside it. Fit width fills the column.">
          ${VIEWPORTS.map((v) => `<option value="${v.value}">${v.label}</option>`).join('')}
        </select>
      </span>
    </div>
  `;
  const play = host.querySelector('#tpPlay') as HTMLButtonElement;
  const start = host.querySelector('#tpStart') as HTMLElement;
  const end = host.querySelector('#tpEnd') as HTMLElement;
  const now = host.querySelector('#tpNow') as HTMLElement;
  const scrub = host.querySelector('#tpScrub') as HTMLInputElement;
  const buffered = host.querySelector('#tpBuffered') as HTMLElement;
  const hover = host.querySelector('#tpHover') as HTMLElement;
  const hoverTime = host.querySelector('#tpHoverTime') as HTMLElement;
  const thumb = host.querySelector('#tpThumb') as HTMLElement;
  const thumbTile = host.querySelector('#tpThumbTile') as HTMLElement;
  const goLive = host.querySelector('#tpLive') as HTMLButtonElement;
  const mute = host.querySelector('#tpMute') as HTMLButtonElement;
  const volume = host.querySelector('#tpVolume') as HTMLInputElement;
  const nativeToggle = host.querySelector('#tpNativeToggle') as HTMLInputElement;
  const viewport = host.querySelector('#tpViewport') as HTMLSelectElement;
  const main = host.querySelector('.tp-main') as HTMLElement;
  const rendered = host.querySelector('#tpRendered') as HTMLElement;
  const frame = host.querySelector('#tpFrame') as HTMLElement;
  const scale = host.querySelector('#tpScale') as HTMLElement;
  const tracksWrap = host.querySelector('#tpTracks') as HTMLElement;
  const audioWrap = host.querySelector('#tpAudioWrap') as HTMLElement;
  const audioSelect = host.querySelector('#tpAudio') as HTMLSelectElement;
  const textWrap = host.querySelector('#tpTextWrap') as HTMLElement;
  const textSelect = host.querySelector('#tpText') as HTMLSelectElement;
  const rate = host.querySelector('#tpRate') as HTMLSelectElement;

  let dragging = false;

  function liveApi(): LiveView | null {
    const engine = deps.engine();
    return (engine as { live?: LiveView } | null)?.live ?? null;
  }
  function pdtApi(): PdtView | null {
    const engine = deps.engine();
    return (engine as { pdt?: PdtView } | null)?.pdt ?? null;
  }
  function thumbnailsApi(): ThumbnailsView | null {
    const engine = deps.engine();
    return (engine as { thumbnails?: ThumbnailsView } | null)?.thumbnails ?? null;
  }

  /** Puts the sprite tile for a time into the hover card, scaled to THUMB_WIDTH. */
  function showThumb(time: number): void {
    const tile = thumbnailsApi()?.at(time) ?? null;
    thumb.hidden = tile === null;
    if (tile === null) return;
    const scale = THUMB_WIDTH / tile.width;
    thumb.style.width = `${THUMB_WIDTH}px`;
    thumb.style.height = `${Math.round(tile.height * scale)}px`;
    thumbTile.style.width = `${tile.width}px`;
    thumbTile.style.height = `${tile.height}px`;
    thumbTile.style.transform = `scale(${scale})`;
    thumbTile.style.backgroundImage = `url("${tile.url}")`;
    thumbTile.style.backgroundPosition = `-${tile.x}px -${tile.y}px`;
  }

  /** The seekable span from the element, or the duration for a source that reports none. */
  function span(): { start: number; end: number } | null {
    const ranges = video.seekable;
    if (ranges.length > 0) {
      return { start: ranges.start(0), end: ranges.end(ranges.length - 1) };
    }
    if (Number.isFinite(video.duration) && video.duration > 0) {
      return { start: 0, end: video.duration };
    }
    return null;
  }

  /**
   * A time label: wall clock when the stream carries a date anchor, otherwise
   * elapsed presentation time. The title names the label's role and gives the
   * raw presentation time either way.
   */
  function label(role: string, time: number): { text: string; title: string } {
    const clock = pdtApi()?.toWallClock(time) ?? null;
    if (clock !== null) {
      return {
        text: fmtClock(clock),
        title: `${role}, as wall clock from the stream's date anchor · ${time.toFixed(1)}s presentation time`,
      };
    }
    return {
      text: fmtPresentation(time),
      title: `${role}, as presentation time (the stream carries no date anchor) · ${time.toFixed(1)}s`,
    };
  }

  function timeAt(fraction: number): number | null {
    const s = span();
    if (s === null) return null;
    return s.start + Math.min(1, Math.max(0, fraction)) * (s.end - s.start);
  }

  function seekToFraction(fraction: number): void {
    const t = timeAt(fraction);
    if (t !== null) video.currentTime = t;
  }

  play.addEventListener('click', () => {
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  });
  scrub.addEventListener('pointerdown', () => {
    dragging = true;
  });
  scrub.addEventListener('input', () => {
    const t = timeAt(Number(scrub.value) / STEPS);
    if (t !== null) now.textContent = label('Playhead', t).text;
  });
  scrub.addEventListener('change', () => {
    dragging = false;
    seekToFraction(Number(scrub.value) / STEPS);
  });
  scrub.addEventListener('pointermove', (event) => {
    const rect = scrub.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    const t = timeAt(fraction);
    if (t === null) {
      hover.hidden = true;
      return;
    }
    const l = label('Time under the cursor', t);
    hoverTime.textContent = l.text;
    hover.title = l.title;
    showThumb(t);
    hover.style.left = `${(fraction * 100).toFixed(2)}%`;
    hover.hidden = false;
  });
  scrub.addEventListener('pointerleave', () => {
    hover.hidden = true;
  });
  goLive.addEventListener('click', () => liveApi()?.seekToEdge());
  mute.addEventListener('click', () => {
    video.muted = !video.muted;
    poll();
  });
  volume.addEventListener('input', () => {
    video.volume = Number(volume.value) / 100;
    if (video.volume > 0) video.muted = false;
    poll();
  });

  function applyNative(native: boolean): void {
    video.controls = native;
    host.classList.toggle('tp-native-on', native);
    nativeToggle.checked = native;
  }
  nativeToggle.addEventListener('change', () => {
    applyNative(nativeToggle.checked);
    try {
      localStorage.setItem(CONTROLS_KEY, nativeToggle.checked ? '1' : '0');
    } catch {
      // Storage is a convenience; the toggle still works for the session.
    }
  });
  let remembered = false;
  try {
    remembered = localStorage.getItem(CONTROLS_KEY) === '1';
  } catch {
    // No storage: custom controls, the playground's default.
  }
  applyNative(remembered);

  rate.addEventListener('change', () => {
    video.playbackRate = Number(rate.value);
  });

  audioSelect.addEventListener('change', () => {
    deps.engine()?.tracks.select(audioSelect.value);
  });
  textSelect.addEventListener('change', () => {
    const engine = deps.engine();
    if (engine === null) return;
    if (textSelect.value === '') engine.tracks.deselect('text');
    else engine.tracks.select(textSelect.value);
  });

  // The selects rebuild only when their inputs change, so an open menu is
  // never torn down under the pointer by the half-second poll.
  let tracksSignature = '';
  function renderTracks(): void {
    const engine = deps.engine();
    const available = engine?.tracks.available ?? [];
    const activeAudio = engine?.tracks.active('audio')?.id;
    const activeText = engine?.tracks.active('text')?.id;
    const audio = collapseGroups(
      available.filter((t) => t.contentType === 'audio'),
      activeAudio,
    );
    const text = collapseGroups(
      available.filter((t) => t.contentType === 'text'),
      activeText,
    );
    const signature = JSON.stringify([
      audio.map((t) => t.id),
      text.map((t) => t.id),
      activeAudio,
      activeText,
    ]);
    if (signature === tracksSignature) return;
    tracksSignature = signature;

    audioSelect.replaceChildren(
      ...audio.map((t) => new Option(trackName(t), t.id, false, t.id === activeAudio)),
    );
    textSelect.replaceChildren(
      new Option('Off', '', false, activeText === undefined),
      ...text.map((t) => new Option(trackName(t), t.id, false, t.id === activeText)),
    );
    // One audio track is a fact, not a choice.
    audioWrap.hidden = audio.length < 2;
    textWrap.hidden = text.length === 0;
    tracksWrap.hidden = audioWrap.hidden && textWrap.hidden;
  }

  function applyViewport(value: string): void {
    deps.card.style.setProperty('--viewport-width', value === 'fit' ? '100%' : `${value}px`);
    viewport.value = value;
  }
  viewport.addEventListener('change', () => {
    applyViewport(viewport.value);
    try {
      localStorage.setItem(VIEWPORT_KEY, viewport.value);
    } catch {
      // Storage is a convenience.
    }
  });
  // 360p by default: a full-width player on a wide page is a wall, and the
  // point of the viewport is to see the frame at a size a viewer would.
  let rememberedViewport = '640';
  try {
    const saved = localStorage.getItem(VIEWPORT_KEY);
    if (saved !== null && VIEWPORTS.some((v) => v.value === saved)) rememberedViewport = saved;
  } catch {
    // No storage: 640 × 360.
  }
  applyViewport(rememberedViewport);

  function poll(): void {
    // The status row: the box the video lands in, the frame decoded into
    // it, and how the two relate. Labelled so each number explains itself.
    const rect = video.getBoundingClientRect();
    rendered.textContent = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
    if (video.videoWidth > 0 && rect.width > 0) {
      frame.textContent = `${video.videoWidth}×${video.videoHeight}`;
      const ratio = video.videoWidth / rect.width;
      scale.textContent =
        ratio > 1.05
          ? `${ratio.toFixed(1)}× downscaled`
          : ratio < 0.95
            ? `${(1 / ratio).toFixed(1)}× upscaled`
            : '1:1';
      scale.hidden = false;
    } else {
      frame.textContent = '—';
      scale.hidden = true;
    }
    // With native controls the browser draws the transport; the whole top
    // row goes, and the track menus with it (the caption menu is native).
    main.hidden = host.classList.contains('tp-native-on');
    if (document.activeElement !== rate) {
      const current = String(video.playbackRate);
      if (rate.value !== current && RATES.includes(video.playbackRate)) rate.value = current;
    }
    renderTracks();
    play.textContent = video.paused ? '▶' : '❚❚';
    play.title = video.paused
      ? "Play: calls the video element's own play(); the engine follows the element"
      : "Pause: calls the video element's own pause(); the engine follows the element";
    mute.textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
    if (document.activeElement !== volume) {
      volume.value = String(Math.round((video.muted ? 0 : video.volume) * 100));
    }

    const s = span();
    if (s === null || s.end <= s.start) {
      start.textContent = '';
      end.textContent = '';
      now.textContent = '';
      scrub.disabled = true;
      buffered.style.width = '0';
      goLive.hidden = true;
      return;
    }
    scrub.disabled = false;
    const live = liveApi();
    const length = s.end - s.start;
    const startLabel = label(
      'Start of the seekable range: the oldest point you can seek to',
      s.start,
    );
    const endLabel = label(
      live?.edge != null
        ? 'End of the seekable range: the live edge, which keeps moving'
        : 'End of the seekable range',
      s.end,
    );
    start.textContent = startLabel.text;
    start.title = startLabel.title;
    end.textContent = endLabel.text;
    end.title = endLabel.title;
    if (!dragging) {
      scrub.value = String(Math.round(((video.currentTime - s.start) / length) * STEPS));
      const nowLabel = label('Playhead: the time now playing', video.currentTime);
      now.textContent = nowLabel.text;
      now.title = nowLabel.title;
    }
    // Buffered ahead of the playhead, drawn as a band on the track.
    let ahead = video.currentTime;
    for (let i = 0; i < video.buffered.length; i += 1) {
      if (video.buffered.start(i) <= video.currentTime + 0.25 && video.buffered.end(i) > ahead) {
        ahead = video.buffered.end(i);
      }
    }
    const from = Math.max(0, (video.currentTime - s.start) / length);
    const to = Math.min(1, (ahead - s.start) / length);
    buffered.style.left = `${(from * 100).toFixed(2)}%`;
    buffered.style.width = `${(Math.max(0, to - from) * 100).toFixed(2)}%`;

    // Latency itself reads in the status row below; here only the way back.
    goLive.hidden = live === null || live.edge === null || live.atEdge;
  }

  for (const type of ['play', 'pause', 'timeupdate', 'volumechange', 'durationchange', 'seeked']) {
    video.addEventListener(type, poll);
  }
  poll();
  return { poll };
}
