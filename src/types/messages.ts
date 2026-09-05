/**
 * The message taxonomy. Commands are rejectable intent from the consumer or
 * a stage. Facts are the world reporting what already happened; the reducer
 * may never reject one. Effects are inert descriptors executed outside the
 * reducer.
 *
 * Commands and facts are distinguished by disjoint `type` literal unions, not
 * by a brand field. A brand would force casts or constructors at every
 * creation site, and the diagnostic trace must replay from plain JSON.
 */
import type { MatteboxError } from './error.js';
import type {
  ByteRange,
  ContentType,
  Presentation,
  Segment,
  TimeRangesSnapshot,
  TrackId,
} from './ir.js';
import type { ApplyStrategy, Constraint } from './quality.js';

/** Everything a sink or transform needs to know about the bytes it was handed. */
export interface SegmentMeta {
  readonly trackId: TrackId;
  readonly renditionId: string;
  readonly contentType: ContentType;
  readonly seq: number;
  /** Start in presentation time, in seconds. */
  readonly start: number;
  readonly duration: number;
  /** True for an init segment; `seq` is then meaningless. */
  readonly isInit: boolean;
  readonly discontinuity?: boolean;
}

/**
 * Data that survives structured clone: no functions, no promises, no DOM
 * references. Effects and cue payloads are constrained to this so the
 * reducer stays testable and the ring buffer stays dumpable.
 */
export type Serializable =
  | string
  | number
  | boolean
  | null
  | undefined
  | ArrayBuffer
  | Uint8Array
  | readonly Serializable[]
  | { readonly [key: string]: Serializable };

/** One parsed cue as plain data. Sinks turn these into VTTCue or metadata cues. */
export interface CueDescriptor {
  readonly id?: string;
  /** Start in presentation time, in seconds. */
  readonly start: number;
  readonly end: number;
  readonly text?: string;
  /** WebVTT cue settings, verbatim ("line:90% align:center"). The sink applies known keys. */
  readonly settings?: string;
  readonly payload?: Serializable;
}

/** Rejectable intent, entering through `dispatch`. */
export type Command =
  | { readonly type: 'ATTACH'; readonly element: HTMLMediaElement }
  | { readonly type: 'DETACH' }
  | { readonly type: 'LOAD'; readonly url: string; readonly mimeType?: string }
  | { readonly type: 'UNLOAD' }
  | { readonly type: 'SEEK'; readonly to: number }
  | { readonly type: 'SEEK_TO_LIVE_EDGE' }
  | { readonly type: 'SELECT_TRACK'; readonly trackId: TrackId }
  | { readonly type: 'DESELECT_TRACK'; readonly contentType: ContentType }
  | { readonly type: 'PIN_RENDITION'; readonly renditionId: string; readonly apply: ApplyStrategy }
  | { readonly type: 'RELEASE_PIN' }
  | { readonly type: 'CONSTRAIN'; readonly source: string; readonly constraint: Constraint }
  | { readonly type: 'RELEASE_CONSTRAINT'; readonly source: string }
  | { readonly type: 'SET_BUFFER_GOAL'; readonly seconds: number }
  | { readonly type: 'ABORT_INFLIGHT'; readonly trackId?: TrackId };

/** The world reporting what already happened, entering through `absorb`. Never rejectable. */
export type Fact =
  | { readonly type: 'ELEMENT_ATTACHED'; readonly element: HTMLMediaElement }
  | { readonly type: 'MEDIASOURCE_OPEN' }
  | { readonly type: 'MEDIASOURCE_CLOSED' }
  | { readonly type: 'MANIFEST_LOADED'; readonly presentation: Presentation }
  | { readonly type: 'MANIFEST_FAILED'; readonly error: MatteboxError }
  | {
      readonly type: 'PLAYLIST_REFRESHED';
      readonly trackId: TrackId;
      readonly renditionId?: string;
      readonly mediaSequence: number;
      readonly segments: readonly Segment[];
    }
  | {
      readonly type: 'SEGMENT_LOADED';
      readonly trackId: TrackId;
      readonly seq: number;
      /**
       * The fetch effect's token. The reducer matches the request by it, so
       * a late response for an aborted request never masquerades as the
       * refetch that replaced it (same track, same sequence, other
       * rendition: the bytes would decode against the wrong init segment).
       */
      readonly token?: string;
      readonly bytes: ArrayBuffer;
      readonly rtt: number;
      readonly size: number;
      /** Wall clock at receipt, epoch seconds. Live edge arithmetic input; the reducer never reads a clock. */
      readonly wallClock?: number;
    }
  | {
      readonly type: 'SEGMENT_FAILED';
      readonly trackId: TrackId;
      readonly seq: number;
      readonly status?: number;
      /** The rendition the failed request belonged to, when the transport knew it. */
      readonly renditionId?: string;
      readonly error: MatteboxError;
    }
  | { readonly type: 'SOURCEBUFFER_CREATED'; readonly sbId: string; readonly codecs: string }
  | {
      readonly type: 'SOURCEBUFFER_UPDATEEND';
      readonly sbId: string;
      /**
       * Snapshot of the buffer's real ranges at updateend. Browsers coalesce
       * and round appended ranges, so state tracks what the buffer reports,
       * not what was appended. Optional: a detach race may have no buffer
       * left to read.
       */
      readonly ranges?: TimeRangesSnapshot;
    }
  | { readonly type: 'SOURCEBUFFER_ERROR'; readonly sbId: string; readonly error: MatteboxError }
  | { readonly type: 'QUOTA_EXCEEDED'; readonly sbId: string }
  | {
      readonly type: 'TIME_UPDATE';
      readonly currentTime: number;
      readonly buffered: TimeRangesSnapshot;
      /** Wall clock at the event, epoch seconds. Slides live windows between refreshes. */
      readonly wallClock?: number;
    }
  | { readonly type: 'SEEKING'; readonly to: number }
  | { readonly type: 'SEEKED'; readonly at: number }
  | { readonly type: 'STALLED'; readonly at: number }
  | {
      readonly type: 'ENCRYPTED';
      readonly initDataType: string;
      readonly initData: ArrayBuffer;
    }
  | { readonly type: 'THROUGHPUT_SAMPLE'; readonly bps: number; readonly trackId: TrackId }
  | { readonly type: 'ENDED'; readonly at: number }
  | {
      /** A scheduled timer fired. The kernel ignores it; slices match on their own token. */
      readonly type: 'TICK';
      readonly token: string;
      /** Wall clock at firing, epoch seconds, stamped by the schedule runner. */
      readonly wallClock?: number;
    }
  | {
      /**
       * A live stage recomputed the availability window. `end` bounds what
       * the scheduler may fetch; `edge` is where seekToLiveEdge lands,
       * behind `end` by the hold-back.
       */
      readonly type: 'LIVE_WINDOW_CHANGED';
      readonly start: number;
      readonly end: number;
      readonly edge: number;
    };

export type Message = Command | Fact;

/**
 * Inert descriptors executed by the effect runner. Plain serializable data:
 * no closures, no promises, no DOM references. Every asynchronous effect
 * carries a `token` so its result can be correlated and `abort` can target
 * it. An effect's outcome always re-enters as a fact, never as a command.
 */
export type Effect =
  | {
      readonly kind: 'fetch';
      readonly token: string;
      readonly url: string;
      readonly range?: ByteRange;
      readonly timeout?: number;
    }
  | { readonly kind: 'abort'; readonly token: string }
  /** Drops every SourceBuffer and the MediaSource, and attaches a fresh MediaSource to the element. */
  | { readonly kind: 'resetSource' }
  | { readonly kind: 'createSourceBuffer'; readonly sbId: string; readonly codecs: string }
  | {
      readonly kind: 'append';
      readonly sbId: string;
      readonly data: ArrayBuffer;
      /**
       * The segment's presentation start, forwarded to a media transform so
       * a transmux step can align its baseMediaDecodeTime to the playlist
       * timeline. Absent on CMAF appends, which run no transform.
       */
      readonly start?: number;
      /** The segment's rendition and sequence, so a transform can find its playlist entry (a key, say). */
      readonly renditionId?: string;
      readonly seq?: number;
    }
  | {
      readonly kind: 'remove';
      readonly sbId: string;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: 'changeType'; readonly sbId: string; readonly codecs: string }
  | { readonly kind: 'setTimestampOffset'; readonly sbId: string; readonly offset: number }
  | { readonly kind: 'endOfStream'; readonly reason?: 'network' | 'decode' }
  | { readonly kind: 'setDuration'; readonly seconds: number }
  /** Publishes the live window as the element's seekable range (MSE setLiveSeekableRange). */
  | { readonly kind: 'setLiveSeekableRange'; readonly start: number; readonly end: number }
  | { readonly kind: 'seekElement'; readonly to: number }
  | {
      readonly kind: 'emitCues';
      readonly trackId: TrackId;
      readonly cues: readonly CueDescriptor[];
    }
  | {
      /**
       * Routes one segment's bytes through the transform pipeline into the
       * registered sink for a cue content type. The media path appends to a
       * SourceBuffer instead; this is its peer for text and metadata.
       */
      readonly kind: 'deliver';
      readonly trackId: TrackId;
      readonly contentType: ContentType;
      readonly data: ArrayBuffer;
      readonly meta: SegmentMeta;
    }
  | {
      readonly kind: 'clearCues';
      readonly trackId: TrackId;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: 'schedule';
      readonly token: string;
      readonly delayMs: number;
      readonly then: Message;
    }
  | { readonly kind: 'emit'; readonly event: string; readonly payload: Serializable };
