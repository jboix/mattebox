/**
 * The dash-cmaf protocol adapter as a stage. Inert module: exports a
 * factory, registers nothing at import time.
 *
 * A templated MPD (SegmentTemplate) is self-contained: one manifest fetch
 * parses straight into a complete Presentation with lazy indexed addressing.
 * The on-demand profile (SegmentBase) is not: each Representation is one file
 * indexed by a `sidx` box, so the concrete segments are unknown until that box
 * is fetched. That second phase mirrors HLS's media-playlist fetch: the parse
 * emits `sidx` addressing, this slice fetches the index byte range under a
 * `dash:idx:` token the transport correlates back, parses it, and merges the
 * resolved segments into the presentation.
 */

import { normalizeMimeType } from '../../kernel/mime.js';
import type { Presentation, Rendition, SegmentAddressing, SidxSegments } from '../../types/ir.js';
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { Effect, Message } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';
import { mergeSidx, parse, sidxToSegments } from './parse.js';

const INDEX_TOKEN = 'dash:idx:';

/** The MPD MIME type, ISO 23009-1 §C.2. */
const MANIFEST_TYPES: readonly string[] = ['application/dash+xml'];

/** Unresolved on-demand addressing, or null for an explicit list or template. */
function asSidx(addressing: SegmentAddressing | undefined): SidxSegments | null {
  if (addressing === undefined || Array.isArray(addressing)) return null;
  const candidate = addressing as IndexedOrSidx;
  return candidate.kind === 'sidx' ? (candidate as SidxSegments) : null;
}
type IndexedOrSidx = { readonly kind: string };

interface DashSlice {
  readonly manifestUrl: string | null;
  /** The caller's `mimeType` from LOAD, normalized, or null to sniff the bytes. */
  readonly mimeType: string | null;
  /** sidx index fetches in flight, token to renditionId. */
  readonly pending: Readonly<Record<string, string>>;
}

const INITIAL: DashSlice = { manifestUrl: null, mimeType: null, pending: {} };

/**
 * Whether this adapter owns the manifest bytes. An explicit mimeType
 * decides alone; without one, an MPD is an XML document and starts with
 * '<'. The parser reports a wrong root element as a parse failure.
 */
function claims(state: DashSlice, text: string): boolean {
  if (state.mimeType !== null) return MANIFEST_TYPES.includes(state.mimeType);
  return text.trimStart().startsWith('<');
}

function findRendition(presentation: Presentation, renditionId: string): Rendition | null {
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.id === renditionId) return rendition;
      }
    }
  }
  return null;
}

/**
 * The renditions whose sidx index still needs fetching: every rendition of
 * every active track. Resolving only the "chosen" one is not enough, because
 * the kernel selects the audio rendition independently (an audio adaptation
 * set often has several bitrates) and may pick a different one than this slice
 * would; its segments would then stay unresolved and the audio buffer would
 * never fill, stalling playback since the element's buffered range is the
 * intersection across all source buffers. Resolving them all also means an ABR
 * switch finds its target already indexed. The fetches are one small range
 * each, so the cost is negligible.
 */
function neededIndexes(kernel: Readonly<KernelState>): readonly Rendition[] {
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
        if (asSidx(rendition.segments) !== null) needed.push(rendition);
      }
    }
  }
  return needed;
}

/** Loops a message back into the bus through a zero-delay schedule effect. */
function feed(message: Message): Effect {
  // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
  return { kind: 'schedule', token: 'dash:loopback', delayMs: 0, then: message };
}

const reduceDash: SliceReducer<DashSlice> = (slice, msg, kernel) => {
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
    return [state, [feed({ type: 'MANIFEST_LOADED', presentation: result.presentation })]];
  }

  // A fetched sidx index resolves one Representation's segments.
  if (msg.type === 'SEGMENT_LOADED' && msg.trackId.startsWith(INDEX_TOKEN)) {
    const renditionId = state.pending[msg.trackId];
    if (renditionId === undefined || kernel.presentation === null) return [state, []];
    const rendition = findRendition(kernel.presentation, renditionId);
    const pending = { ...state.pending };
    delete pending[msg.trackId];
    const sidx = asSidx(rendition?.segments);
    if (sidx === null) {
      return [{ ...state, pending }, []];
    }
    const segments = sidxToSegments(new Uint8Array(msg.bytes), sidx);
    if (segments.length === 0) return [{ ...state, pending }, []];
    const merged = mergeSidx(kernel.presentation, renditionId, segments);
    return [{ ...state, pending }, [feed({ type: 'MANIFEST_LOADED', presentation: merged })]];
  }

  // After a manifest lands or time moves, fetch any sidx index the current
  // selection still lacks.
  if (msg.type === 'MANIFEST_LOADED' || msg.type === 'TIME_UPDATE') {
    const needed = neededIndexes(kernel).filter(
      (rendition) => !Object.values(state.pending).includes(rendition.id),
    );
    if (needed.length === 0) return [state, []];
    const effects: Effect[] = [];
    const pending = { ...state.pending };
    for (const rendition of needed) {
      const token = `${INDEX_TOKEN}${rendition.id}`;
      if (pending[token] !== undefined) continue;
      const sidx = asSidx(rendition.segments);
      if (sidx === null) continue;
      pending[token] = rendition.id;
      effects.push({ kind: 'fetch', token, url: sidx.url, range: sidx.indexRange });
    }
    return [{ ...state, pending }, effects];
  }

  return [state, []];
};

/**
 * The stage factory. `mattebox({ stages: [dashCmaf()] })` is all a consumer
 * needs for DASH-CMAF VOD, templated or on-demand.
 */
export default function dashCmaf(): Stage {
  return {
    name: 'dash-cmaf',
    provides: ['dash-cmaf', ...MANIFEST_TYPES],
    install(ctx) {
      ctx.reduce('dash', reduceDash as SliceReducer);
    },
  };
}
