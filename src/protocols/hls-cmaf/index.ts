/**
 * The hls-cmaf protocol adapter as a stage. Inert module: exports a
 * factory, registers nothing at import time.
 *
 * The choreography is a slice reducer, so the whole protocol lives inside
 * the message loop and the trace: manifest bytes arrive as SEGMENT_LOADED
 * facts, parsing is pure, and results loop back through zero-delay
 * schedule effects carrying MANIFEST_LOADED. Media playlists fetch under
 * `hls:pl:` tokens the transport correlates back by token.
 */

import { normalizeMimeType } from '../../kernel/mime.js';
import type { Presentation, Rendition, Track } from '../../types/ir.js';
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { Effect, Message } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';
import { mergePlaylist, parse, parseMediaPlaylist } from './parse.js';

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
  /** Media-playlist fetches in flight, token to renditionId. */
  readonly pending: Readonly<Record<string, string>>;
}

const INITIAL: HlsSlice = { manifestUrl: null, mimeType: null, pending: {} };

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

function findRendition(
  presentation: Presentation,
  renditionId: string,
): { rendition: Rendition; track: Track } | null {
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.id === renditionId) return { rendition, track };
      }
    }
  }
  return null;
}

/**
 * The renditions whose media playlists still need fetching: every rendition of
 * every active track. Fetching only the "chosen" one is not enough, because ABR
 * (or any switch policy) selects independently and can pick a rendition this
 * slice would not have; its segments would then stay empty and the scheduler
 * would stall the moment ABR ramped onto it, which looks like playback dying
 * once the buffer drains. Fetching all of an active track's playlists means the
 * rendition ABR lands on is already loaded, and a switch never stalls.
 */
function neededPlaylists(kernel: Readonly<KernelState>): readonly Rendition[] {
  const presentation = kernel.presentation;
  if (presentation === null) return [];
  const activeIds = new Set(
    (['video', 'audio', 'text'] as const)
      .map((contentType) => kernel.tracks.active.get(contentType))
      .filter((id): id is string => id !== undefined),
  );
  const needed: Rendition[] = [];
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      if (!activeIds.has(track.id)) continue;
      for (const rendition of track.renditions) {
        if (
          rendition.playlistUrl !== undefined &&
          Array.isArray(rendition.segments) &&
          rendition.segments.length === 0
        ) {
          needed.push(rendition);
        }
      }
    }
  }
  return needed;
}

/** Loops a message back into the bus through a zero-delay schedule effect. */
function feed(message: Message): Effect {
  // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
  return { kind: 'schedule', token: 'hls:loopback', delayMs: 0, then: message };
}

function loopBack(presentation: Presentation): Effect {
  return feed({ type: 'MANIFEST_LOADED', presentation });
}

const reduceHls: SliceReducer<HlsSlice> = (slice, msg, kernel) => {
  const state = slice ?? INITIAL;

  if (msg.type === 'LOAD') {
    return [
      {
        manifestUrl: msg.url,
        mimeType: msg.mimeType === undefined ? null : normalizeMimeType(msg.mimeType),
        pending: {},
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
    return [state, [loopBack(result.presentation)]];
  }

  if (msg.type === 'SEGMENT_LOADED' && msg.trackId.startsWith(PLAYLIST_TOKEN)) {
    const renditionId = state.pending[msg.trackId];
    if (renditionId === undefined || kernel.presentation === null) return [state, []];
    const site = findRendition(kernel.presentation, renditionId);
    const pending = { ...state.pending };
    delete pending[msg.trackId];
    if (site === null || site.rendition.playlistUrl === undefined) {
      return [{ ...state, pending }, []];
    }
    const text = new TextDecoder().decode(msg.bytes);
    const media = parseMediaPlaylist(text, site.rendition.playlistUrl);
    if (media.playlist === null) {
      return [
        { ...state, pending },
        [
          feed({
            type: 'MANIFEST_FAILED',
            error: media.error ?? {
              category: 'manifest',
              code: 'MANIFEST_PARSE_FAILED',
              fatal: true,
              recoverable: false,
            },
          }),
        ],
      ];
    }
    const merged = mergePlaylist(kernel.presentation, renditionId, media.playlist);
    return [{ ...state, pending }, [loopBack(merged)]];
  }

  // After a manifest lands, a selection changes, or time moves, fetch any
  // media playlist the current selection still lacks. Selection is its own
  // trigger: on a paused or stalled element no TIME_UPDATE ever comes, and
  // a track whose playlist never loads is one the element can never play.
  if (msg.type === 'MANIFEST_LOADED' || msg.type === 'SELECT_TRACK' || msg.type === 'TIME_UPDATE') {
    const needed = neededPlaylists(kernel).filter(
      (rendition) => !Object.values(state.pending).includes(rendition.id),
    );
    if (needed.length === 0) return [state, []];
    const effects: Effect[] = [];
    const pending = { ...state.pending };
    for (const rendition of needed) {
      const token = `${PLAYLIST_TOKEN}${rendition.id}`;
      if (pending[token] !== undefined) continue;
      pending[token] = rendition.id;
      effects.push({ kind: 'fetch', token, url: rendition.playlistUrl as string });
    }
    return [{ ...state, pending }, effects];
  }

  return [state, []];
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
