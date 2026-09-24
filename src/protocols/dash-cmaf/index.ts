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
 * `dash:idx:` token the transport correlates back, parses it, and feeds the
 * resolved segments back as a PLAYLIST_REFRESHED the kernel merges.
 */

import { normalizeMimeType } from '../../kernel/mime.js';
import { ladderNeighbours } from '../../kernel/rendition-select.js';
import type { MatteboxError } from '../../types/error.js';
import type {
  Presentation,
  Rendition,
  SegmentAddressing,
  SidxSegments,
  Track,
} from '../../types/ir.js';
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { Effect, Message } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';
import { parse, sidxToSegments } from './parse.js';

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
  /**
   * sidx index fetches not yet merged, token to renditionId. An entry stays
   * until the rendition's PLAYLIST_REFRESHED lands, so the rendition is
   * never asked for twice while its merge is on its way.
   */
  readonly pending: Readonly<Record<string, string>>;
  /** Renditions whose index failed to load or held no segment. Never fetched again. */
  readonly failed: Readonly<Record<string, true>>;
  /** The selection last looked at, so the index choice runs only when it changes. */
  readonly seen: string;
}

const INITIAL: DashSlice = { manifestUrl: null, mimeType: null, pending: {}, failed: {}, seen: '' };

/** The constraint source that excludes renditions whose index failed. */
const UNAVAILABLE = 'dash:unavailable';

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

function findTrackOf(presentation: Presentation, renditionId: string): Track | null {
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      if (track.renditions.some((r) => r.id === renditionId)) return track;
    }
  }
  return null;
}

/**
 * The renditions whose sidx index the selection needs and this slice has
 * not asked for: the playing video rendition and its ladder neighbours, and
 * every rendition of the active audio and text tracks. The kernel selects
 * the audio rendition on its own (an audio adaptation set often has several
 * bitrates) and keeps no record of the pick, so all of them resolve; an
 * unresolved one would never fill the audio buffer. The whole video ladder
 * does not: ABR steps one rung at a time, and a longer jump resolves when
 * it happens, while the buffer plays.
 */
function neededIndexes(state: DashSlice, kernel: Readonly<KernelState>): readonly Rendition[] {
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
          if (asSidx(rendition.segments) === null) continue;
          if (asked.has(rendition.id) || rendition.id in state.failed) continue;
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
  return { kind: 'schedule', token: 'dash:loopback', delayMs: 0, then: message };
}

/**
 * An index that failed to load or held no segment. The rendition is
 * excluded, so arbitration moves off it and nothing asks for the index
 * again. When that leaves a media track with no rendition at all, the load
 * fails: the stream cannot play, and waiting would only stall.
 */
function unavailable(
  state: DashSlice,
  kernel: Readonly<KernelState>,
  renditionId: string,
  error: MatteboxError,
): [DashSlice, Effect[]] {
  const failed: Record<string, true> = { ...state.failed, [renditionId]: true };
  const next = { ...state, failed };
  const presentation = kernel.presentation;
  if (presentation === null) return [next, []];
  const track = findTrackOf(presentation, renditionId);
  const media = track?.contentType === 'video' || track?.contentType === 'audio';
  if (track !== null && media && track.renditions.every((r) => r.id in failed)) {
    return [next, [feed({ type: 'MANIFEST_FAILED', error: { ...error, fatal: true } })]];
  }
  return [
    next,
    [
      feed({
        type: 'CONSTRAIN',
        source: UNAVAILABLE,
        constraint: { excludeIds: Object.keys(failed) },
      }),
    ],
  ];
}

const reduceDash: SliceReducer<DashSlice> = (slice, msg, kernel) => {
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

  // The merge landed: the rendition is resolved in the kernel's
  // presentation, or gone from it. Either way it is no longer pending.
  if (msg.type === 'PLAYLIST_REFRESHED' && msg.renditionId !== undefined) {
    const renditionId = msg.renditionId;
    const token = `${INDEX_TOKEN}${renditionId}`;
    if (token in next.pending) {
      const pending = { ...next.pending };
      delete pending[token];
      next = { ...next, pending };
    }
  }

  // A fetched sidx index resolves one Representation's segments.
  if (msg.type === 'SEGMENT_LOADED' && msg.trackId in state.pending) {
    const renditionId = state.pending[msg.trackId] as string;
    const sidx =
      kernel.presentation === null
        ? null
        : asSidx(findRendition(kernel.presentation, renditionId)?.segments);
    const segments = sidx === null ? [] : sidxToSegments(new Uint8Array(msg.bytes), sidx);
    if (sidx !== null && segments.length > 0) {
      // Stays pending until the merge lands.
      return [
        state,
        [
          feed({
            type: 'PLAYLIST_REFRESHED',
            trackId: renditionId,
            renditionId,
            mediaSequence: segments[0]?.seq ?? 0,
            segments,
          }),
        ],
      ];
    }
    const pending = { ...state.pending };
    delete pending[msg.trackId];
    // The rendition left the presentation (a reload replaced it): nothing to do.
    if (sidx === null) return [{ ...state, pending }, []];
    // An index with no segment can never be played from, and fetching the
    // same bytes again gives the same answer.
    const error: MatteboxError = {
      category: 'media',
      code: 'MEDIA_CONTAINER_INVALID',
      fatal: false,
      recoverable: false,
      context: { renditionId, reason: 'sidx holds no segment' },
    };
    const [failed, failEffects] = unavailable({ ...state, pending }, kernel, renditionId, error);
    return [
      failed,
      [
        {
          kind: 'emit',
          event: 'error',
          payload: {
            category: error.category,
            code: error.code,
            fatal: false,
            recoverable: false,
            renditionId,
          },
        },
        ...failEffects,
      ],
    ];
  }

  if (msg.type === 'SEGMENT_FAILED' && msg.trackId in state.pending) {
    // The transport already retried under its policy; the kernel reported
    // the failure. What is left is to stop relying on the rendition.
    const renditionId = state.pending[msg.trackId] as string;
    const pending = { ...state.pending };
    delete pending[msg.trackId];
    return unavailable({ ...state, pending }, kernel, renditionId, msg.error);
  }

  // Look at the selection again when it changed: a manifest, a merge, a
  // track or quality switch, a constraint. Each bumps the quality version.
  // A suspended engine makes no request and keeps the old key, so RESUME
  // fills what a selection during the freeze left lacking.
  if (kernel.lifecycle.phase !== 'ready' || kernel.presentation === null) return [next, []];
  const key = `${kernel.quality.version}:${kernel.quality.active}`;
  if (key === next.seen && msg.type !== 'RESUME') return [next, []];
  const effects: Effect[] = [];
  const pending = { ...next.pending };
  for (const rendition of neededIndexes(next, kernel)) {
    const sidx = asSidx(rendition.segments);
    if (sidx === null) continue;
    const token = `${INDEX_TOKEN}${rendition.id}`;
    pending[token] = rendition.id;
    // The rendition rides along so a failure counts toward steering failover.
    effects.push({
      kind: 'fetch',
      token,
      url: sidx.url,
      range: sidx.indexRange,
      renditionId: rendition.id,
    });
  }
  return [{ ...next, pending, seen: key }, effects];
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
