/**
 * The hls-cmaf protocol adapter as a stage. Inert module: exports a
 * factory, registers nothing at import time.
 *
 * The choreography is a slice reducer, so the whole protocol lives inside
 * the message loop and the trace: manifest bytes arrive as SEGMENT_LOADED
 * facts, parsing is pure, and results loop back through zero-delay
 * schedule effects: MANIFEST_LOADED for the multivariant playlist, one
 * PLAYLIST_REFRESHED per rendition for a media playlist. Media playlists
 * fetch under `hls:pl:` tokens the transport correlates back by token.
 */

import { normalizeMimeType } from '../../kernel/mime.js';
import { ladderNeighbours } from '../../kernel/rendition-select.js';
import type { MatteboxError } from '../../types/error.js';
import type { Presentation, Rendition } from '../../types/ir.js';
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { Effect, Message } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';
import { parse, parseMediaPlaylist, refreshFor } from './parse.js';
import { LOAD_FAILED, unavailableMessages } from './unavailable.js';

const PLAYLIST_TOKEN = 'hls:pl:';

/** The playlist MIME types, RFC 8216 §4: the registered type and the three in common use. */
const MANIFEST_TYPES: readonly string[] = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
];

interface HlsSlice {
  readonly manifestUrl: string | null;
  /** The caller's `mimeType` from LOAD, normalized, or null to sniff the bytes. */
  readonly mimeType: string | null;
  /** Media-playlist fetches in flight, token to playlist URL. */
  readonly pending: Readonly<Record<string, string>>;
  /**
   * Playlist URLs already answered: true when they loaded, false when they
   * failed. Neither is fetched again by this slice; hls-live reloads a live
   * playlist on its own cadence.
   */
  readonly answered: Readonly<Record<string, boolean>>;
  /** The selection last looked at, so the playlist choice runs only when it changes. */
  readonly seen: string;
}

const INITIAL: HlsSlice = {
  manifestUrl: null,
  mimeType: null,
  pending: {},
  answered: {},
  seen: '',
};

/**
 * Whether this adapter owns the manifest bytes. An explicit mimeType
 * decides alone: a foreign type declines without reading, an own type
 * parses without sniffing, so a broken playlist reports a parse failure
 * instead of falling through. Without one, RFC 8216 §4.3.1.1: the first
 * line of every playlist is #EXTM3U.
 */
function claims(state: HlsSlice, text: string): boolean {
  if (state.mimeType !== null) return MANIFEST_TYPES.includes(state.mimeType);
  return text.trimStart().startsWith('#EXTM3U');
}

/**
 * The playlist URLs the selection needs and this slice has not asked for:
 * the playing video rendition and its ladder neighbours, and every
 * rendition of the active audio and text tracks (one each in practice; an
 * audio-only ladder is short). Fetching the whole ladder up front costs one
 * request per variant, hundreds on a large multivariant playlist.
 */
function neededPlaylists(state: HlsSlice, kernel: Readonly<KernelState>): readonly Rendition[] {
  const presentation = kernel.presentation;
  if (presentation === null) return [];
  const asked = new Set(Object.values(state.pending));
  const needed: Rendition[] = [];
  for (const contentType of ['video', 'audio', 'text'] as const) {
    const trackId = kernel.tracks.active.get(contentType);
    if (trackId === undefined) continue;
    for (const period of presentation.periods) {
      for (const track of period.tracks) {
        if (track.id !== trackId) continue;
        const candidates =
          contentType === 'video'
            ? ladderNeighbours(track.renditions, kernel.quality.active, kernel.quality.constraints)
            : track.renditions;
        for (const rendition of candidates) {
          const url = rendition.playlistUrl;
          if (url === undefined || url in state.answered || asked.has(url)) continue;
          if (needed.some((r) => r.playlistUrl === url)) continue;
          needed.push(rendition);
        }
      }
    }
  }
  return needed;
}

/** Every rendition that reads the playlist at `url`. */
function renditionsAt(presentation: Presentation, url: string): readonly Rendition[] {
  const out: Rendition[] = [];
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.playlistUrl === url) out.push(rendition);
      }
    }
  }
  return out;
}

/** Loops a message back into the bus through a zero-delay schedule effect. */
function feed(message: Message): Effect {
  // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
  return { kind: 'schedule', token: 'hls:loopback', delayMs: 0, then: message };
}

/**
 * A playlist that failed to load or parse. Its renditions are excluded,
 * so arbitration moves off them and nothing asks for the playlist again.
 * When that leaves a media track with no rendition at all, the load
 * fails: the stream cannot play, and waiting would only stall.
 */
function unavailable(
  state: HlsSlice,
  kernel: Readonly<KernelState>,
  url: string,
  error: MatteboxError,
): [HlsSlice, Effect[]] {
  const answered = { ...state.answered, [url]: false };
  const next = { ...state, answered };
  const presentation = kernel.presentation;
  if (presentation === null) return [next, []];
  const failed: string[] = [];
  for (const [failedUrl, ok] of Object.entries(answered)) {
    if (!ok)
      for (const rendition of renditionsAt(presentation, failedUrl)) failed.push(rendition.id);
  }
  return [next, unavailableMessages(kernel, LOAD_FAILED, failed, error).map(feed)];
}

const reduceHls: SliceReducer<HlsSlice> = (slice, msg, kernel) => {
  const state = slice ?? INITIAL;

  if (msg.type === 'LOAD') {
    return [
      {
        ...INITIAL,
        manifestUrl: msg.url,
        mimeType: msg.mimeType === undefined ? null : normalizeMimeType(msg.mimeType),
      },
      [],
    ];
  }
  if (msg.type === 'UNLOAD' || msg.type === 'DETACH') {
    return [INITIAL, []];
  }

  if (msg.type === 'SEGMENT_LOADED' && msg.trackId === 'manifest' && state.manifestUrl !== null) {
    const text = new TextDecoder().decode(msg.bytes);
    // Declining returns no effect; the kernel reports bytes nobody claims.
    if (!claims(state, text)) return [state, []];
    const result = parse(text, state.manifestUrl);
    if (result.presentation === null) {
      return [
        state,
        [
          feed({
            type: 'MANIFEST_FAILED',
            error: result.error ?? {
              category: 'manifest',
              code: 'MANIFEST_PARSE_FAILED',
              fatal: true,
              recoverable: false,
            },
          }),
        ],
      ];
    }
    return [state, [feed({ type: 'MANIFEST_LOADED', presentation: result.presentation })]];
  }

  let next = state;
  const effects: Effect[] = [];

  if (msg.type === 'SEGMENT_LOADED' && msg.trackId in state.pending) {
    const url = state.pending[msg.trackId] as string;
    const pending = { ...state.pending };
    delete pending[msg.trackId];
    next = { ...next, pending };
    const media = parseMediaPlaylist(new TextDecoder().decode(msg.bytes), url);
    const playlist = media.playlist;
    // A complete playlist with no segment can never be played from, the
    // same as one that does not parse.
    const error: MatteboxError | null =
      playlist === null
        ? (media.error ?? {
            category: 'manifest',
            code: 'MANIFEST_PARSE_FAILED',
            fatal: false,
            recoverable: false,
          })
        : playlist.endlist && playlist.segments.length === 0
          ? { category: 'manifest', code: 'MANIFEST_EMPTY', fatal: false, recoverable: false }
          : null;
    if (error !== null || playlist === null || kernel.presentation === null) {
      if (error === null) return [next, effects];
      effects.push({
        kind: 'emit',
        event: 'error',
        payload: {
          category: error.category,
          code: error.code,
          fatal: false,
          recoverable: false,
          url,
        },
      });
      const [failed, failEffects] = unavailable(next, kernel, url, error);
      return [failed, [...effects, ...failEffects]];
    }
    next = { ...next, answered: { ...next.answered, [url]: true } };
    // One fetch serves every rendition that reads this playlist. Each
    // merges as its own fact, into the presentation the kernel holds
    // when the fact lands.
    for (const rendition of renditionsAt(kernel.presentation, url)) {
      const refresh = refreshFor(kernel.presentation, rendition.id, playlist);
      if (refresh !== null) effects.push(feed(refresh));
    }
    return [next, effects];
  }

  if (msg.type === 'SEGMENT_FAILED' && msg.trackId in state.pending) {
    // The transport already retried under its policy; the kernel reported
    // the failure. What is left is to stop relying on the playlist.
    const url = state.pending[msg.trackId] as string;
    const pending = { ...state.pending };
    delete pending[msg.trackId];
    return unavailable({ ...next, pending }, kernel, url, msg.error);
  }

  // Look at the selection again when it changed: a manifest, a merge, a
  // track or quality switch, a constraint. Each bumps the quality version.
  // A suspended engine makes no request and keeps the old key, so RESUME
  // fills what a selection during the freeze left lacking.
  if (kernel.lifecycle.phase !== 'ready' || kernel.presentation === null) return [next, effects];
  const key = `${kernel.quality.version}:${kernel.quality.active}`;
  if (key === state.seen && msg.type !== 'RESUME') return [next, effects];
  next = { ...next, seen: key };
  const pending = { ...next.pending };
  for (const rendition of neededPlaylists(next, kernel)) {
    const url = rendition.playlistUrl as string;
    const token = `${PLAYLIST_TOKEN}${url}`;
    pending[token] = url;
    // The rendition rides along so a failure counts toward steering failover.
    effects.push({ kind: 'fetch', token, url, renditionId: rendition.id });
  }
  return [{ ...next, pending }, effects];
};

/**
 * The stage factory. `mattebox({ stages: [hlsCmaf()] })` is all a consumer
 * needs for HLS-CMAF VOD.
 */
export default function hlsCmaf(): Stage {
  return {
    name: 'hls-cmaf',
    provides: ['hls-cmaf', ...MANIFEST_TYPES],
    install(ctx) {
      ctx.reduce('hls', reduceHls as SliceReducer);
    },
  };
}
