/**
 * The intermediate representation: the normalized timeline model every
 * protocol adapter targets. Nothing above Layer 1 sees protocol-specific
 * structures. This module imports nothing; it is the leaf of the type graph.
 */

/** Routed by the kernel to a registered sink. No registration: the track is enumerated but not selectable. */
export type ContentType = 'video' | 'audio' | 'text' | 'metadata' | 'image';

export type TrackId = string;
export type RenditionId = string;

/** Inclusive byte range for a partial fetch (HLS EXT-X-BYTERANGE, DASH @range). */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/** A [start, end) window in presentation time, in seconds. */
export interface TimeRange {
  readonly start: number;
  readonly end: number;
}

/**
 * A plain-data copy of the element's TimeRanges. TimeRanges itself is a live
 * DOM object; snapshots keep messages and state serializable.
 */
export type TimeRangesSnapshot = readonly TimeRange[];

/** Addresses one fetchable resource, such as an init segment. */
export interface SegmentRef {
  readonly url: string;
  readonly byteRange?: ByteRange;
}

/** One media segment. `start` and `duration` are in seconds of presentation time. */
/**
 * Full-segment encryption (HLS EXT-X-KEY METHOD=AES-128): the whole segment
 * is one AES-CBC message with PKCS7 padding. Not DRM: the key is a plain
 * 16-byte fetch, so this rides on segments for a decrypt transform, never on
 * a track's `protection`, which is the EME route.
 */
export interface SegmentKey {
  readonly method: 'AES-128';
  /** Absolute URL of the 16-byte key. */
  readonly uri: string;
  /** Explicit IV as 32 hex digits. Absent: the media sequence number, big-endian in 16 bytes (RFC 8216 §5.2). */
  readonly iv?: string;
}

export interface Segment {
  readonly seq: number;
  readonly start: number;
  readonly duration: number;
  readonly url: string;
  readonly byteRange?: ByteRange;
  /** True when a timestamp discontinuity begins at this segment (HLS EXT-X-DISCONTINUITY). */
  readonly discontinuity?: boolean;
  /** Present while an AES-128 key applies; absent after METHOD=NONE or when never keyed. */
  readonly key?: SegmentKey;
}

/**
 * A run of consecutive segments with equal duration (DASH SegmentTimeline
 * S@t/@d/@r). Long live windows compress to a handful of runs.
 */
export interface SegmentRun {
  /** Start of the run in timescale units. */
  readonly start: number;
  /** Duration of each segment in the run, in timescale units. */
  readonly duration: number;
  /** Number of segments in the run. */
  readonly count: number;
}

/**
 * Indexed segment addressing (DASH SegmentTemplate, and any templated form).
 * Segments are derived on demand from this data, so an adapter never
 * materializes an array for a long live window.
 */
export interface IndexedSegments {
  readonly kind: 'indexed';
  /**
   * URL template. `$Number$` expands to the sequence number and `$Time$` to
   * the segment start in timescale units. ISO/IEC 23009-1 §5.3.9.4.4.
   */
  readonly urlTemplate: string;
  readonly startSeq: number;
  /** Null for a live window with no announced end. */
  readonly endSeq: number | null;
  /** Timescale units per second for `segmentDuration` and `timeline`. */
  readonly timescale: number;
  /** Constant segment duration in timescale units. Null when `timeline` is present. */
  readonly segmentDuration: number | null;
  /** Explicit timeline as compressed runs. Null when `segmentDuration` is constant. */
  readonly timeline: readonly SegmentRun[] | null;
  /** Offset subtracted from media time to map into period time, in timescale units. */
  readonly presentationTimeOffset?: number;
}

/**
 * On-demand addressing (DASH SegmentBase): one file per Representation whose
 * segments are described by a `sidx` box at `indexRange`. The concrete
 * segments are unknown until that box is fetched and parsed, at which point
 * the adapter replaces this with an explicit `Segment[]` carrying byte ranges.
 */
export interface SidxSegments {
  readonly kind: 'sidx';
  /** The single media file (DASH BaseURL under the Representation). */
  readonly url: string;
  /** Byte range of the `sidx` box within the file (SegmentBase@indexRange). */
  readonly indexRange: ByteRange;
  /** SegmentBase@timescale; the sidx carries its own, this is the fallback. */
  readonly timescale: number;
  /** Offset subtracted from media time to map into period time, in seconds. */
  readonly presentationTimeOffset?: number;
}

/** Explicit list, indexed template, or a to-be-fetched sidx index. */
export type SegmentAddressing = readonly Segment[] | IndexedSegments | SidxSegments;

/**
 * One DRM signaling entry. Init data arrives by two routes (manifest and
 * media); adapters emit whatever the manifest declares and `eme-core` dedupes
 * by key ID.
 */
export interface ProtectionScheme {
  /** DASH ContentProtection @schemeIdUri key-system UUID. Null for HLS METHOD-only signaling. */
  readonly systemId: string | null;
  /** Encryption scheme or method, such as 'cenc', 'cbcs', or an HLS EXT-X-KEY METHOD value. */
  readonly scheme: string | null;
  /** Default key ID, hex encoded. */
  readonly keyId: string | null;
  /** Key or license URI (HLS EXT-X-KEY URI). */
  readonly licenseUrl: string | null;
  /** Init data carried in the manifest, such as a pssh box. */
  readonly initData: ArrayBuffer | null;
  /** EME init data type for `initData`, such as 'cenc' or 'keyids'. */
  readonly initDataType: string | null;
}

/** Track-level DRM signaling. */
export interface ProtectionInfo {
  readonly schemes: readonly ProtectionScheme[];
}

/**
 * Content-steering data, normalized: HLS pathways are variant clones (the
 * rendition carries its pathway id); DASH pathways are BaseURL choices
 * (the bases map holds them). The steering stage consumes both shapes.
 */
export interface SteeringInfo {
  /** The steering manifest URI, resolved absolute. */
  readonly serverUri: string;
  readonly defaultPathway?: string;
  /** DASH: pathway id (serviceLocation) to absolute base URL. */
  readonly bases?: Readonly<Record<string, string>>;
}

/** One quality level of a track. */
export interface Rendition {
  readonly id: RenditionId;
  readonly bitrate: number;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  /** RFC 6381 codec string. Null when the manifest does not declare one, common for text. */
  readonly codecs: string | null;
  readonly mimeType: string;
  readonly init?: SegmentRef;
  readonly segments: SegmentAddressing;
  /**
   * HLS only: the media playlist backing this rendition. Segments stay
   * empty until the protocol stage fetches and merges it.
   */
  readonly playlistUrl?: string;
  /** The content-steering pathway this rendition belongs to (HLS PATHWAY-ID). */
  readonly pathway?: string;
}

/**
 * A generic track descriptor. Parsers must never branch on content type to
 * construct typed objects; the kernel routes on `contentType` and `mimeType`.
 */
export interface Track {
  readonly id: TrackId;
  readonly contentType: ContentType;
  readonly mimeType: string;
  readonly lang?: string;
  /** Free-form role, such as 'main', 'alternate', 'subtitle', 'caption'. */
  readonly role?: string;
  /**
   * Mandatory even when no DRM stage is loaded, so adding DRM later does not
   * touch every adapter. Null means the track is clear.
   */
  readonly protection: ProtectionInfo | null;
  readonly renditions: readonly Rendition[];
}

/**
 * One HLS variant expressed as data: selecting `renditionId` requires the
 * named companion tracks. DASH usually leaves the table empty because any
 * composition is valid. Encoding this as data is what keeps `abr` from
 * importing `alt-audio`.
 */
export interface Coupling {
  readonly renditionId: RenditionId;
  readonly requires: Partial<Record<ContentType, TrackId>>;
}

/** A continuous span of the presentation with a fixed track set. */
export interface Period {
  readonly id: string;
  /** Start in presentation time, in seconds. */
  readonly start: number;
  /** Absent when the period runs to the next period boundary or the live edge. */
  readonly duration?: number;
  readonly tracks: readonly Track[];
}

/**
 * Live delivery metadata, normalized from either manifest family. Absent
 * for pure VOD. The kernel never computes with wall clocks; live stages
 * turn these into LIVE_WINDOW_CHANGED facts.
 */
export interface LiveInfo {
  /** availabilityStartTime as epoch seconds. */
  readonly availabilityStart?: number;
  /** Manifest refresh cadence in seconds (minimumUpdatePeriod, or the playlist target duration). */
  readonly updatePeriod?: number;
  /** DVR depth in seconds (timeShiftBufferDepth). */
  readonly timeShiftDepth?: number;
  /** Distance behind the availability end to hold playback, in seconds. */
  readonly holdBack?: number;
  /** A time server for clock skew (DASH UTCTiming). */
  readonly timeServer?: { readonly scheme: string; readonly value: string };
  /** A wall-clock anchor: `wallClock` epoch seconds corresponds to `presentationTime`. */
  readonly dateAnchor?: { readonly wallClock: number; readonly presentationTime: number };
}

/** The root of the IR. One per loaded manifest. */
export interface Presentation {
  readonly id: string;
  readonly isLive: boolean;
  /** Absent for live presentations without an announced end. */
  readonly duration?: number;
  readonly periods: readonly Period[];
  readonly couplings: readonly Coupling[];
  readonly live?: LiveInfo;
  readonly steering?: SteeringInfo;
}
