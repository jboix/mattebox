/**
 * The event log: one line per thing that happened, in wall-clock order,
 * with a plain-language message and the raw JSON one click away. It merges
 * three sources: the reducer trace (commands and facts), the engine's
 * emitted events (errors, DRM, recovery), and the media element's own
 * events. Rows are appended incrementally, never re-rendered wholesale, so
 * scrolling and an expanded entry survive the refresh tick.
 */
import type { Effect, Mattebox, Message, TraceEntry } from '../../src/index.js';
import { fmtBitrate } from './dock.js';
import { createTraceCursor } from './trace-cursor.js';

export type Level = 'error' | 'warn' | 'info' | 'debug';
export type Source = 'command' | 'fact' | 'event' | 'media';

export interface LogEntry {
  readonly id: number;
  /** performance.now() at the event. */
  readonly t: number;
  readonly level: Level;
  readonly source: Source;
  readonly type: string;
  readonly message: string;
  /** Effect kinds the reducer answered with, for trace-backed entries. */
  readonly effects: string;
  readonly detail: unknown;
  readonly trace?: TraceEntry;
}

export interface LogFilter {
  text: string;
  levels: Set<Level>;
  source: Source | 'all';
}

const COMMANDS = new Set([
  'ATTACH',
  'DETACH',
  'LOAD',
  'UNLOAD',
  'SEEK',
  'SEEK_TO_LIVE_EDGE',
  'SELECT_TRACK',
  'DESELECT_TRACK',
  'PIN_RENDITION',
  'RELEASE_PIN',
  'CONSTRAIN',
  'RELEASE_CONSTRAINT',
  'SET_BUFFER_GOAL',
  'ABORT_INFLIGHT',
]);

/** High-frequency facts that only the verbose level shows. */
const CHATTY = new Set(['TIME_UPDATE', 'TICK', 'THROUGHPUT_SAMPLE', 'SOURCEBUFFER_UPDATEEND']);

/** Engine events and the level each deserves. Everything unlisted is info. */
const EVENT_LEVELS: Record<string, Level> = {
  'command:rejected': 'warn',
  'kernel:slice-error': 'error',
  'playback:stalled': 'warn',
  'quality:abr-invalid': 'warn',
  'quality:constraints-unsatisfiable': 'warn',
  'quality:coupling-unsatisfiable': 'warn',
  'quality:pin-unsatisfiable': 'warn',
  'quality:stale-segment': 'warn',
  'quota:exhausted': 'warn',
  'recovery:excluded': 'warn',
  'recovery:flush': 'warn',
  'recovery:gap-jump': 'warn',
  'recovery:nudge': 'warn',
  'recovery:skip': 'warn',
  'recovery:readmitted': 'info',
  'steering:failover': 'warn',
};
const EVENT_NAMES = [
  'error',
  'command:rejected',
  'kernel:slice-error',
  'playback:stalled',
  'playback:ended',
  'quality:abr-invalid',
  'quality:constraints-unsatisfiable',
  'quality:coupling-unsatisfiable',
  'quality:pin-unsatisfiable',
  'quality:stale-segment',
  'quota:exhausted',
  'recovery:excluded',
  'recovery:flush',
  'recovery:gap-jump',
  'recovery:nudge',
  'recovery:skip',
  'recovery:readmitted',
  'steering:failover',
  'drm:encrypted',
  'drm:keysystem',
  'drm:keystatus',
  'codecprobe:detected',
  'tracks:changed',
  'presentation:protection',
];

const MEDIA_EVENTS: Record<string, Level> = {
  loadedmetadata: 'info',
  loadeddata: 'debug',
  canplay: 'debug',
  canplaythrough: 'debug',
  play: 'info',
  playing: 'info',
  pause: 'info',
  waiting: 'warn',
  stalled: 'warn',
  suspend: 'debug',
  seeking: 'info',
  seeked: 'info',
  ended: 'info',
  error: 'error',
  ratechange: 'debug',
  durationchange: 'debug',
  resize: 'info',
  encrypted: 'info',
  waitingforkey: 'warn',
  emptied: 'debug',
  abort: 'warn',
};

const MEDIA_ERR = ['', 'ABORTED', 'NETWORK', 'DECODE', 'SRC_NOT_SUPPORTED'];

export function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtRanges(ranges: ReadonlyArray<{ start: number; end: number }> | undefined): string {
  if (ranges === undefined || ranges.length === 0) return 'empty';
  return ranges.map((r) => `${r.start.toFixed(1)}–${r.end.toFixed(1)}`).join(', ');
}

function fmtTime(t: number): string {
  const d = new Date(performance.timeOrigin + t);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.split('/').filter((s) => s !== '');
    return `${u.host}/…/${path.slice(-2).join('/')}`;
  } catch {
    return url;
  }
}

function errorText(
  error: { code?: string; context?: Record<string, unknown> } | undefined,
): string {
  if (error === undefined) return '';
  const ctx = error.context ?? {};
  const extra = [ctx.status, ctx.reason, ctx.codecs, ctx.message]
    .filter((v) => v !== undefined && v !== null && v !== '')
    .map(String);
  return [error.code, ...extra].filter((s) => s).join(' · ');
}

/** The plain-language line for a reducer message, and the level it earns. */
function describe(msg: Message): { message: string; level: Level } {
  const m = msg as Record<string, unknown> & { type: string };
  switch (msg.type) {
    case 'ATTACH':
      return { message: 'attach engine to the media element', level: 'info' };
    case 'DETACH':
      return { message: 'detach engine', level: 'info' };
    case 'LOAD':
      return { message: `load ${shortUrl(msg.url)}`, level: 'info' };
    case 'UNLOAD':
      return { message: 'unload', level: 'info' };
    case 'SEEK':
      return { message: `seek to ${msg.to.toFixed(2)}s`, level: 'info' };
    case 'SEEK_TO_LIVE_EDGE':
      return { message: 'seek to the live edge', level: 'info' };
    case 'SELECT_TRACK':
      return { message: `select track ${msg.trackId}`, level: 'info' };
    case 'DESELECT_TRACK':
      return { message: `deselect ${msg.contentType}`, level: 'info' };
    case 'PIN_RENDITION':
      return { message: `pin rendition ${msg.renditionId} (apply ${msg.apply})`, level: 'info' };
    case 'RELEASE_PIN':
      return { message: 'release pin, ABR resumes', level: 'info' };
    case 'CONSTRAIN':
      return {
        message: `constrain ${msg.source}: ${Object.entries(msg.constraint)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : String(v)}`)
          .join(' ')}`,
        level: 'info',
      };
    case 'RELEASE_CONSTRAINT':
      return { message: `release constraint ${msg.source}`, level: 'info' };
    case 'SET_BUFFER_GOAL':
      return { message: `buffer goal ${msg.seconds}s`, level: 'info' };
    case 'ABORT_INFLIGHT':
      return { message: `abort in-flight ${msg.trackId ?? 'requests'}`, level: 'info' };
    case 'ELEMENT_ATTACHED':
      return { message: 'media element attached', level: 'info' };
    case 'MEDIASOURCE_OPEN':
      return { message: 'MediaSource open', level: 'info' };
    case 'MEDIASOURCE_CLOSED':
      return { message: 'MediaSource closed', level: 'info' };
    case 'MANIFEST_LOADED': {
      const p = msg.presentation;
      const tracks = p.periods.flatMap((period) => period.tracks);
      const count = (type: string) => tracks.filter((t) => t.contentType === type).length;
      const video = tracks.find((t) => t.contentType === 'video');
      const protectedTracks = tracks.filter((t) => (t.protection?.schemes.length ?? 0) > 0);
      return {
        message: `manifest loaded: ${p.isLive ? 'live' : `VOD ${p.duration?.toFixed(0) ?? '?'}s`}, ${
          p.periods.length
        } period(s), ${video?.renditions.length ?? 0} video rendition(s), ${count(
          'audio',
        )} audio, ${count('text')} text${
          protectedTracks.length > 0 ? `, DRM on ${protectedTracks.length} track(s)` : ''
        }`,
        level: 'info',
      };
    }
    case 'MANIFEST_FAILED':
      return { message: `manifest failed: ${errorText(msg.error)}`, level: 'error' };
    case 'PLAYLIST_REFRESHED':
      return {
        message: `playlist ${msg.trackId}${msg.renditionId ? `/${msg.renditionId}` : ''} refreshed: seq ${
          msg.mediaSequence
        }, ${msg.segments.length} segments`,
        level: 'debug',
      };
    case 'SEGMENT_LOADED':
      return {
        message: `${msg.trackId} #${msg.seq} loaded: ${fmtBytes(msg.size)} in ${msg.rtt.toFixed(
          0,
        )} ms (${fmtBitrate((msg.size * 8000) / Math.max(msg.rtt, 1))})`,
        level: 'info',
      };
    case 'SEGMENT_FAILED':
      return {
        message: `${msg.trackId} #${msg.seq} failed: ${
          msg.status !== undefined ? `HTTP ${msg.status} · ` : ''
        }${errorText(msg.error)}`,
        level: msg.error.fatal ? 'error' : 'warn',
      };
    case 'SOURCEBUFFER_CREATED':
      return { message: `source buffer ${msg.sbId} created: ${msg.codecs}`, level: 'info' };
    case 'SOURCEBUFFER_UPDATEEND':
      return { message: `${msg.sbId} updated, buffered ${fmtRanges(msg.ranges)}`, level: 'debug' };
    case 'SOURCEBUFFER_ERROR':
      return { message: `${msg.sbId} error: ${errorText(msg.error)}`, level: 'error' };
    case 'QUOTA_EXCEEDED':
      return { message: `${msg.sbId} quota exceeded, evicting`, level: 'warn' };
    case 'TIME_UPDATE':
      return {
        message: `t=${msg.currentTime.toFixed(2)} buffered ${fmtRanges(msg.buffered)}`,
        level: 'debug',
      };
    case 'SEEKING':
      return { message: `seeking to ${msg.to.toFixed(2)}s`, level: 'info' };
    case 'SEEKED':
      return { message: `seeked, at ${msg.at.toFixed(2)}s`, level: 'info' };
    case 'STALLED':
      return { message: `stalled at ${msg.at.toFixed(2)}s`, level: 'warn' };
    case 'ENCRYPTED':
      return {
        message: `encrypted: ${msg.initDataType} init data, ${msg.initData.byteLength} B`,
        level: 'info',
      };
    case 'THROUGHPUT_SAMPLE':
      return { message: `throughput ${fmtBitrate(msg.bps)} (${msg.trackId})`, level: 'debug' };
    case 'ENDED':
      return { message: `ended at ${msg.at.toFixed(2)}s`, level: 'info' };
    case 'TICK':
      return { message: `tick ${msg.token}`, level: 'debug' };
    case 'LIVE_WINDOW_CHANGED':
      return {
        message: `live window ${msg.start.toFixed(1)}–${msg.end.toFixed(1)}, edge ${msg.edge.toFixed(
          1,
        )}`,
        level: 'debug',
      };
    default: {
      const scalars = Object.entries(m)
        .filter(([k, v]) => k !== 'type' && (typeof v === 'string' || typeof v === 'number'))
        .slice(0, 4)
        .map(([k, v]) => `${k}=${String(v)}`);
      return { message: scalars.join(' '), level: CHATTY.has(m.type) ? 'debug' : 'info' };
    }
  }
}

function effectSummary(effects: readonly Effect[]): string {
  if (effects.length === 0) return '';
  const counts = new Map<string, number>();
  for (const e of effects) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(' ');
}

function describeEvent(name: string, payload: unknown): { message: string; level: Level } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const level = EVENT_LEVELS[name] ?? 'info';
  switch (name) {
    case 'error': {
      const fatal = p.fatal === true;
      return {
        message: `${fatal ? 'fatal ' : ''}${String(p.category ?? '')} error: ${errorText(
          p as { code?: string; context?: Record<string, unknown> },
        )}`,
        level: fatal ? 'error' : 'warn',
      };
    }
    case 'command:rejected':
      return {
        message: `command ${String((p.command as { type?: string } | undefined)?.type ?? p.type ?? '')} rejected${
          p.reason !== undefined ? `: ${String(p.reason)}` : ''
        }`,
        level,
      };
    case 'drm:keysystem':
      return { message: `key system selected: ${String(p.keySystem)}`, level };
    case 'drm:keystatus':
      return {
        message: `key ${String(p.keyId ?? '')} status ${String(p.status ?? '')}`,
        level: p.status === 'usable' ? 'info' : 'warn',
      };
    case 'drm:encrypted':
      return { message: `encrypted media detected (${String(p.initDataType ?? '')})`, level };
    case 'codecprobe:detected':
      return { message: `codec probed: ${String(p.codecs ?? JSON.stringify(p))}`, level };
    case 'tracks:changed':
      return {
        message: `track list changed: ${
          Array.isArray(p.available) ? `${p.available.length} track(s)` : ''
        }`,
        level,
      };
    case 'quality:constraints-unsatisfiable':
      return {
        message: `constraints left no rendition; dropped ${
          Array.isArray(p.dropped) ? p.dropped.join(', ') : ''
        }`,
        level,
      };
    case 'quality:stale-segment':
      return {
        message: `dropped ${String(p.renditionId ?? '')} #${String(p.seq ?? '')}: the buffer is initialized for ${String(
          p.initFor ?? '',
        )}; refetching from that rendition`,
        level,
      };
    case 'quality:pin-unsatisfiable':
      return { message: `pinned rendition ${String(p.renditionId ?? '')} is not playable`, level };
    case 'playback:stalled':
      return { message: `playback stalled at ${Number(p.at ?? 0).toFixed(2)}s`, level };
    case 'playback:ended':
      return { message: 'playback ended', level };
    default: {
      const scalars = Object.entries(p)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .slice(0, 5)
        .map(([k, v]) => `${k}=${String(v)}`);
      return { message: scalars.join(' '), level };
    }
  }
}

function describeMedia(name: string, video: HTMLVideoElement): string {
  switch (name) {
    case 'loadedmetadata':
      return `metadata: ${video.videoWidth}×${video.videoHeight}, duration ${
        Number.isFinite(video.duration) ? `${video.duration.toFixed(1)}s` : 'live'
      }`;
    case 'resize':
      return `video size ${video.videoWidth}×${video.videoHeight}`;
    case 'error':
      return `media error ${MEDIA_ERR[video.error?.code ?? 0] ?? video.error?.code}${
        video.error?.message ? `: ${video.error.message}` : ''
      }`;
    case 'waiting':
      return `waiting for data at ${video.currentTime.toFixed(2)}s`;
    case 'stalled':
      return `network stalled at ${video.currentTime.toFixed(2)}s`;
    case 'ratechange':
      return `playback rate ${video.playbackRate}`;
    case 'durationchange':
      return `duration ${Number.isFinite(video.duration) ? video.duration.toFixed(1) : '∞'}`;
    case 'seeking':
    case 'seeked':
    case 'play':
    case 'playing':
    case 'pause':
    case 'ended':
      return `${name} at ${video.currentTime.toFixed(2)}s`;
    default:
      return name;
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof ArrayBuffer) return `ArrayBuffer(${value.byteLength})`;
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.byteLength})`;
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (typeof value === 'object' && value !== null && 'nodeName' in (value as object))
    return '[element]';
  return value;
}

export function toJson(value: unknown, indent = 1): string {
  try {
    return JSON.stringify(value, replacer, indent);
  } catch (error) {
    return `(not serializable: ${String((error as Error).message)})`;
  }
}

export interface EventLog {
  /** Subscribes to a freshly built engine and element. Previous subscriptions are dropped. */
  attach(engine: Mattebox, video: HTMLVideoElement): void;
  /** Consumes new trace entries and paints pending rows. Cheap when nothing changed. */
  poll(): void;
  setFilter(filter: LogFilter): void;
  clear(): void;
  /** The trace entry behind the row the user opened last, for replay-up-to. */
  selectedTrace(): TraceEntry | null;
  /** Every row kept, oldest first, for a report. */
  entries(): readonly LogEntry[];
  readonly size: number;
}

const MAX_ROWS = 3000;

export function createEventLog(host: HTMLElement): EventLog {
  const entries: LogEntry[] = [];
  const byId = new Map<number, LogEntry>();
  let nextId = 1;
  const cursor = createTraceCursor();
  let unsubscribe: Array<() => void> = [];
  let selected: LogEntry | null = null;
  let filter: LogFilter = { text: '', levels: new Set(['error', 'warn', 'info']), source: 'all' };

  function visible(entry: LogEntry): boolean {
    if (!filter.levels.has(entry.level)) return false;
    if (filter.source !== 'all' && entry.source !== filter.source) return false;
    if (filter.text !== '') {
      const hay = `${entry.type} ${entry.message} ${entry.effects}`.toLowerCase();
      if (!hay.includes(filter.text)) return false;
    }
    return true;
  }

  function rowFor(entry: LogEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = `log-row lvl-${entry.level} src-${entry.source}`;
    row.dataset.id = String(entry.id);
    row.hidden = !visible(entry);
    row.innerHTML = `<span class="log-time">${fmtTime(entry.t)}</span><span class="log-src" title="${
      entry.source
    }">${entry.source === 'command' ? 'cmd' : entry.source === 'fact' ? 'fact' : entry.source === 'event' ? 'evt' : 'el'}</span><span class="log-type">${
      entry.type
    }</span><span class="log-msg">${entry.message}</span>${
      entry.effects !== '' ? `<span class="log-fx">→ ${entry.effects}</span>` : ''
    }`;
    row.addEventListener('click', () => {
      const open = row.classList.toggle('open');
      const existing = row.querySelector('pre');
      if (open && existing === null) {
        const pre = document.createElement('pre');
        pre.textContent = toJson(
          entry.trace !== undefined
            ? { msg: entry.trace.msg, effects: entry.trace.effects, digest: entry.trace.digest }
            : entry.detail,
        );
        row.appendChild(pre);
        selected = entry;
      } else if (!open) {
        existing?.remove();
        if (selected === entry) selected = null;
      }
    });
    return row;
  }

  // Events arrive live while trace entries are read on the poll tick, so
  // both wait here and land together, sorted by their clock.
  let pending: Array<Omit<LogEntry, 'id'>> = [];

  function push(entry: Omit<LogEntry, 'id'>): void {
    pending.push(entry);
  }

  function flush(): void {
    if (pending.length === 0) return;
    const batch = pending.sort((a, b) => a.t - b.t);
    pending = [];
    const atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 12;
    const fragment = document.createDocumentFragment();
    for (const entry of batch) {
      const full: LogEntry = { ...entry, id: nextId++ };
      entries.push(full);
      byId.set(full.id, full);
      fragment.appendChild(rowFor(full));
    }
    host.appendChild(fragment);
    while (entries.length > MAX_ROWS) {
      const dropped = entries.shift();
      if (dropped !== undefined) byId.delete(dropped.id);
      host.firstElementChild?.remove();
    }
    if (atBottom) host.scrollTop = host.scrollHeight;
  }

  function consumeTrace(): void {
    for (const entry of cursor.read()) {
      const { message, level } = describe(entry.msg);
      const isCommand = COMMANDS.has(entry.msg.type);
      push({
        t: entry.t,
        level: CHATTY.has(entry.msg.type) ? 'debug' : level,
        source: isCommand ? 'command' : 'fact',
        type: entry.msg.type,
        message,
        effects: effectSummary(entry.effects),
        detail: entry.msg,
        trace: entry,
      });
    }
  }

  return {
    attach(next, video) {
      for (const off of unsubscribe) off();
      unsubscribe = [];
      cursor.reset(next);
      for (const name of EVENT_NAMES) {
        unsubscribe.push(
          next.on(name, (payload) => {
            const { message, level } = describeEvent(name, payload);
            push({
              t: performance.now(),
              level,
              source: 'event',
              type: name,
              message,
              effects: '',
              detail: payload,
            });
          }),
        );
      }
      for (const [name, level] of Object.entries(MEDIA_EVENTS)) {
        const handler = () =>
          push({
            t: performance.now(),
            level,
            source: 'media',
            type: name,
            message: describeMedia(name, video),
            effects: '',
            detail: {
              currentTime: video.currentTime,
              readyState: video.readyState,
              networkState: video.networkState,
              paused: video.paused,
              error:
                video.error !== null
                  ? { code: video.error.code, message: video.error.message }
                  : null,
            },
          });
        video.addEventListener(name, handler);
        unsubscribe.push(() => video.removeEventListener(name, handler));
      }
    },
    poll() {
      if (host.offsetParent === null) return;
      consumeTrace();
      flush();
    },
    setFilter(next) {
      filter = { ...next, text: next.text.toLowerCase() };
      const rows = host.children;
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i] as HTMLElement;
        const entry = byId.get(Number(row.dataset.id));
        row.hidden = entry === undefined ? true : !visible(entry);
      }
      host.scrollTop = host.scrollHeight;
    },
    clear() {
      pending = [];
      entries.length = 0;
      byId.clear();
      host.innerHTML = '';
      selected = null;
    },
    selectedTrace() {
      return selected?.trace ?? null;
    },
    entries() {
      return entries;
    },
    get size() {
      return entries.length;
    },
  };
}
