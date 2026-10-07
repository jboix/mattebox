/**
 * m3u8 into the IR. Pure: no fetching, no state, no side effects. URLs are
 * resolved here, against the playlist's own URL, and stored absolute;
 * downstream code never does URL arithmetic.
 *
 * The HLS variant problem: EXT-X-STREAM-INF describes a bundle of one
 * video rendition plus an audio group plus a subtitle group. The adapter
 * decomposes variants into a video track with renditions, hoists
 * EXT-X-MEDIA entries into their own tracks, and records the bundle in the
 * coupling table as data. Generic descriptors only; the kernel routes.
 */

import { byteToHex } from '../../kernel/base64.js';
import type { PlaylistRefresh } from '../../kernel/refresh.js';
import { applyRefresh } from '../../kernel/refresh.js';
import { resolveUrl as resolve } from '../../kernel/url.js';
import type { MatteboxError } from '../../types/error.js';
import type {
  ByteRange,
  Coupling,
  DateRange,
  Presentation,
  ProtectionInfo,
  Rendition,
  Segment,
  SegmentAddressing,
  SegmentKey,
  SegmentRef,
  SessionData,
  TileGrid,
  Track,
} from '../../types/ir.js';
import type { ParseResult } from '../adapter-shared.js';
import { manifestError } from '../adapter-shared.js';
import { dimensions } from '../dimensions.js';
import type { TagLine } from './lexer.js';
import { lex } from './lexer.js';

export type { ParseResult } from '../adapter-shared.js';

export interface MediaPlaylist {
  readonly segments: readonly Segment[];
  readonly init: SegmentRef | null;
  readonly targetDuration: number;
  readonly mediaSequence: number;
  readonly endlist: boolean;
  readonly playlistType: string | null;
  readonly protection: ProtectionInfo | null;
  /** From the first EXT-X-PROGRAM-DATE-TIME: `wallClock` epoch seconds at `presentationTime`. */
  readonly dateAnchor?: { readonly wallClock: number; readonly presentationTime: number };
  /** From the first EXT-X-TILES of an image playlist. */
  readonly tiles?: TileGrid;
  /** The playlist's EXT-X-DATERANGE tags, merged by ID, on the presentation timeline. */
  readonly dateRanges?: readonly DateRange[];
}

/** Epoch seconds from an ISO 8601 date, or null. */
function epochSeconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * The date ranges of a playlist (RFC 8216bis §4.4.5.1), merged by ID: a
 * later tag with the same ID adds attributes and never changes one. Each
 * maps to the presentation timeline through the playlist's first
 * EXT-X-PROGRAM-DATE-TIME, which a playlist with date ranges must carry; a
 * playlist without one yields none.
 */
function dateRangesFrom(
  tags: readonly Readonly<Record<string, string>>[],
  anchor: { readonly wallClock: number; readonly presentationTime: number } | undefined,
): DateRange[] {
  if (anchor === undefined) return [];
  const merged = new Map<string, Record<string, string>>();
  for (const attributes of tags) {
    const id = attributes.ID;
    if (id === undefined) continue;
    const known = merged.get(id);
    merged.set(id, known === undefined ? { ...attributes } : { ...attributes, ...known });
  }
  const toPresentation = (epoch: number) => anchor.presentationTime + (epoch - anchor.wallClock);
  const out: DateRange[] = [];
  for (const [id, attributes] of merged) {
    const startDate = epochSeconds(attributes['START-DATE']);
    if (startDate === null) continue;
    const start = toPresentation(startDate);
    const endDate = epochSeconds(attributes['END-DATE']);
    const duration = Number(attributes.DURATION);
    const planned = Number(attributes['PLANNED-DURATION']);
    const end =
      endDate !== null
        ? toPresentation(endDate)
        : Number.isFinite(duration)
          ? start + duration
          : undefined;
    out.push({
      id,
      start,
      ...(end !== undefined ? { end } : {}),
      ...(Number.isFinite(planned) ? { plannedEnd: start + planned } : {}),
      startDate,
      attributes,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** A media playlist parse either yields the playlist or says why not. */
export type MediaPlaylistResult =
  | { readonly playlist: MediaPlaylist; readonly error: null }
  | { readonly playlist: null; readonly error: MatteboxError };

/** n@o or n (continuing after the previous range). RFC 8216 §4.3.2.2. */
function parseByteRange(value: string, previousEnd: number | null): ByteRange | null {
  const [lengthText, offsetText] = value.split('@');
  const length = Number(lengthText);
  if (!Number.isFinite(length)) return null;
  const start =
    offsetText !== undefined ? Number(offsetText) : previousEnd === null ? 0 : previousEnd + 1;
  if (!Number.isFinite(start)) return null;
  return { start, end: start + length - 1 };
}

/**
 * METHOD=AES-128 as a segment key. Anything else (NONE, SAMPLE-AES, the
 * FairPlay and Widevine forms) is not a segment key: NONE ends keying, the
 * rest are DRM and go through `protectionFrom`.
 */
function segmentKeyFrom(key: TagLine, baseUrl: string): SegmentKey | null {
  if (key.attributes.METHOD !== 'AES-128' || key.attributes.URI === undefined) return null;
  const iv = key.attributes.IV;
  return {
    method: 'AES-128',
    uri: resolve(key.attributes.URI, baseUrl),
    ...(iv !== undefined ? { iv: iv.replace(/^0x/i, '').toLowerCase().padStart(32, '0') } : {}),
  };
}

function protectionFrom(key: TagLine, baseUrl: string): ProtectionInfo | null {
  const method = key.attributes.METHOD ?? '';
  // AES-128 is full-segment encryption, a transform's job, not EME's.
  if (method === '' || method === 'NONE' || method === 'AES-128') return null;
  return {
    schemes: [
      {
        systemId: key.attributes.KEYFORMAT ?? null,
        scheme: method.toLowerCase(),
        keyId: key.attributes.KEYID ?? null,
        licenseUrl: key.attributes.URI !== undefined ? resolve(key.attributes.URI, baseUrl) : null,
        initData: null,
        initDataType: null,
      },
    ],
  };
}

const AUDIO_CODECS = /^(mp4a|ac-3|ec-3|opus|flac)/i;
/** Subtitles in fMP4: IMSC (Apple HLS authoring spec 5.10) and WebVTT. */
const TEXT_CODECS = /^(stpp|wvtt)/i;

/**
 * A tile grid from LAYOUT="CxR" and a tile RESOLUTION, both from the Roku
 * image-playlist specification (EXT-X-IMAGE-STREAM-INF, EXT-X-TILES).
 * DURATION, when present, is the seconds each tile covers.
 */
function tileGridFrom(attributes: Readonly<Record<string, string>>): TileGrid | null {
  const layout = dimensions(attributes.LAYOUT);
  const size = dimensions(attributes.RESOLUTION);
  if (layout === null || size === null) return null;
  const duration = Number(attributes.DURATION);
  return {
    columns: layout[0],
    rows: layout[1],
    width: size[0],
    height: size[1],
    ...(duration > 0 ? { duration } : {}),
  };
}

/**
 * Rewrites the legacy decimal AVC codec form some packagers still emit into
 * the RFC 6381 hex form MSE demands. `avc1.66.30` (profile 66, level 30) is
 * accepted by Firefox but rejected by Chrome's isTypeSupported, which is why a
 * stream like Unified Streaming's plays audio but no video on one browser and
 * nothing on the other. The constraint byte is not carried in this form, so it
 * is emitted as zero; the real flags ride in the avcC the transmux writes.
 */
export function normalizeAvcCodec(codec: string): string {
  const match = /^(avc1|avc3)\.(\d+)\.(\d+)$/.exec(codec);
  if (match === null) return codec;
  return `${match[1]}.${byteToHex(Number(match[2]))}00${byteToHex(Number(match[3]))}`;
}

function splitCodecs(value: string | undefined): {
  video: string | null;
  audio: string | null;
  text: string | null;
} {
  if (value === undefined) return { video: null, audio: null, text: null };
  let video: string | null = null;
  let audio: string | null = null;
  let text: string | null = null;
  for (const codec of value.split(',').map((c) => c.trim())) {
    if (codec === '') continue;
    if (AUDIO_CODECS.test(codec)) {
      audio = audio ?? codec;
    } else if (TEXT_CODECS.test(codec)) {
      text = text ?? codec;
    } else {
      video = video ?? normalizeAvcCodec(codec);
    }
  }
  return { video, audio, text };
}

/** parse a media playlist body into segments. */
export function parseMediaPlaylist(text: string, baseUrl: string): MediaPlaylistResult {
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { playlist: null, error: manifestError('missing #EXTM3U') };
  }
  const lines = lex(text);
  const segments: Segment[] = [];
  let init: SegmentRef | null = null;
  let targetDuration = 0;
  let mediaSequence = 0;
  let endlist = false;
  let playlistType: string | null = null;
  let protection: ProtectionInfo | null = null;
  let pendingKey: SegmentKey | null = null;
  let tiles: TileGrid | null = null;

  let dateAnchor: { wallClock: number; presentationTime: number } | undefined;
  let pendingDate: number | null = null;
  let pendingDuration: number | null = null;
  let pendingRange: ByteRange | null = null;
  let pendingDiscontinuity = false;
  // RFC 8216 §4.3.3.3: the first segment's number, 0 without the tag.
  let discontinuitySequence = 0;
  const dateRangeTags: Readonly<Record<string, string>>[] = [];
  let previousRangeEnd: number | null = null;
  let start = 0;
  let seq = 0;

  for (const line of lines) {
    if (line.kind === 'tag') {
      switch (line.name) {
        case 'EXT-X-TARGETDURATION':
          targetDuration = Number(line.value) || 0;
          break;
        case 'EXT-X-MEDIA-SEQUENCE':
          mediaSequence = Number(line.value) || 0;
          seq = mediaSequence;
          break;
        case 'EXT-X-PLAYLIST-TYPE':
          playlistType = line.value;
          break;
        case 'EXT-X-ENDLIST':
          endlist = true;
          break;
        case 'EXTINF': {
          const comma = line.value.indexOf(',');
          pendingDuration = Number(comma === -1 ? line.value : line.value.slice(0, comma));
          break;
        }
        case 'EXT-X-BYTERANGE':
          pendingRange = parseByteRange(line.value, previousRangeEnd);
          break;
        case 'EXT-X-DISCONTINUITY':
          pendingDiscontinuity = true;
          break;
        case 'EXT-X-DATERANGE':
          dateRangeTags.push(line.attributes);
          break;
        case 'EXT-X-DISCONTINUITY-SEQUENCE':
          discontinuitySequence = Number(line.value) || 0;
          break;
        case 'EXT-X-MAP': {
          const uri = line.attributes.URI;
          if (uri !== undefined) {
            const range =
              line.attributes.BYTERANGE !== undefined
                ? parseByteRange(line.attributes.BYTERANGE, null)
                : null;
            init = {
              url: resolve(uri, baseUrl),
              ...(range !== null ? { byteRange: range } : {}),
            };
          }
          break;
        }
        case 'EXT-X-KEY':
          // A key applies to every segment after it until the next key
          // line; METHOD=NONE ends it.
          pendingKey = segmentKeyFrom(line, baseUrl);
          protection = protectionFrom(line, baseUrl) ?? protection;
          break;
        case 'EXT-X-PROGRAM-DATE-TIME': {
          const parsed = Date.parse(line.value);
          if (Number.isFinite(parsed)) pendingDate = parsed / 1000;
          break;
        }
        case 'EXT-X-TILES':
          // Every segment of an image playlist may carry its own tag; the
          // first one describes the rendition, as packagers repeat one grid.
          tiles = tiles ?? tileGridFrom(line.attributes);
          break;
        default:
          break;
      }
      continue;
    }
    // A URI line closes the pending EXTINF.
    if (pendingDuration === null || !Number.isFinite(pendingDuration)) {
      return { playlist: null, error: manifestError(`segment URI without EXTINF: ${line.uri}`) };
    }
    if (pendingDate !== null && dateAnchor === undefined) {
      dateAnchor = { wallClock: pendingDate, presentationTime: start };
    }
    pendingDate = null;
    // Each discontinuity adds one, also one on the first segment: the tag
    // stays there until the segment leaves the window, and then the server
    // raises the base (RFC 8216 §6.2.2), so a segment keeps its number
    // across reloads. hls.js counts the same way.
    if (pendingDiscontinuity) discontinuitySequence += 1;
    const opensEpoch = segments.length === 0 || pendingDiscontinuity;
    segments.push({
      seq,
      start,
      duration: pendingDuration,
      url: resolve(line.uri, baseUrl),
      ...(pendingRange !== null ? { byteRange: pendingRange } : {}),
      ...(pendingDiscontinuity ? { discontinuity: true } : {}),
      ...(opensEpoch ? { discontinuitySequence } : {}),
      ...(pendingKey !== null ? { key: pendingKey } : {}),
    });
    previousRangeEnd = pendingRange !== null ? pendingRange.end : previousRangeEnd;
    start += pendingDuration;
    seq += 1;
    pendingDuration = null;
    pendingRange = null;
    pendingDiscontinuity = false;
  }

  return {
    playlist: {
      segments,
      init,
      targetDuration,
      mediaSequence,
      endlist,
      playlistType,
      protection,
      ...(dateAnchor !== undefined ? { dateAnchor } : {}),
      ...(tiles !== null ? { tiles } : {}),
      ...(dateRangeTags.length > 0
        ? { dateRanges: dateRangesFrom(dateRangeTags, dateAnchor) }
        : {}),
    },
    error: null,
  };
}

interface MediaEntry {
  readonly type: string;
  readonly groupId: string;
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly uri: string | null;
}

function mediaContentType(type: string): 'audio' | 'text' | null {
  if (type === 'AUDIO') return 'audio';
  if (type === 'SUBTITLES') return 'text';
  // CLOSED-CAPTIONS have no URI (in-band); VIDEO alternates are rare.
  return null;
}

/** The attributes as one string, in name order, leaving out the names `skip` matches. */
function attributeKey(attributes: Readonly<Record<string, string>>, skip?: RegExp): string {
  return Object.keys(attributes)
    .filter((name) => skip?.test(name) !== true)
    .sort()
    .map((name) => `${name}=${attributes[name]}`)
    .join(',');
}

/**
 * RFC 8216bis §4.4.6.1.1: groups of one TYPE carry the same members, and
 * corresponding members differ only in these attributes. A member that
 * matches on everything else is the same rendition in another encoding.
 */
const PER_GROUP = /^(URI|GROUP-ID|CHANNELS|BIT-DEPTH|SAMPLE-RATE|STABLE-RENDITION-ID)$/;

/**
 * RFC 8216bis §4.4.6.1: CHANNELS="6", or "16/JOC" for object-based audio.
 * The first parameter counts the channels; the second names the object
 * coding, where "-" means none.
 */
function channelsOf(entry: MediaEntry): Pick<Rendition, 'channels' | 'audioObjects'> {
  const [count, objects] = (entry.attributes.CHANNELS ?? '').split('/');
  const channels = Number(count);
  return {
    ...(channels > 0 ? { channels } : {}),
    ...(objects !== undefined && objects !== '' && objects !== '-'
      ? { audioObjects: objects }
      : {}),
  };
}

/** The CHARACTERISTICS tags of a rendition, as written, in order. */
function characteristicsOf(entry: MediaEntry): string[] {
  return (entry.attributes.CHARACTERISTICS ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/**
 * RFC 8216bis §4.4.6.1: a CLOSED-CAPTIONS rendition names an in-band
 * caption channel inside the video: a CEA-608 channel (INSTREAM-ID CC1 to
 * CC4) or a CEA-708 service (SERVICE1 to SERVICE63). It becomes a text
 * track with no segments; a caption stage reads the cues from the video.
 */
function captionTrack(entry: MediaEntry): Track | null {
  if (entry.type !== 'CLOSED-CAPTIONS') return null;
  const instreamId = entry.attributes['INSTREAM-ID'] ?? '';
  const mimeType = /^CC[1-4]$/.test(instreamId)
    ? 'application/cea-608'
    : /^SERVICE([1-9]|[1-5]\d|6[0-3])$/.test(instreamId)
      ? 'application/cea-708'
      : null;
  if (mimeType === null) return null;
  const characteristics = characteristicsOf(entry);
  return {
    id: `${entry.groupId}:${entry.name}`,
    contentType: 'text',
    mimeType,
    name: entry.name,
    ...(entry.attributes.AUTOSELECT === 'YES' ? { autoselect: true } : {}),
    protection: null,
    ...(entry.attributes.LANGUAGE !== undefined ? { lang: entry.attributes.LANGUAGE } : {}),
    role: 'caption',
    ...(characteristics.length > 0 ? { characteristics } : {}),
    instreamId,
    renditions: [],
  };
}

/**
 * The rendition fields a tag with a URI attribute declares: the Roku
 * EXT-X-IMAGE-STREAM-INF and the RFC 8216 §4.3.4.3 EXT-X-I-FRAME-STREAM-INF.
 * RESOLUTION names the rendition, BANDWIDTH when it is missing.
 */
function uriStreamRendition(
  attributes: Readonly<Record<string, string>>,
  prefix: string,
  baseUrl: string,
): Pick<Rendition, 'id' | 'bitrate' | 'playlistUrl' | 'width' | 'height'> | null {
  if (attributes.URI === undefined) return null;
  const size = dimensions(attributes.RESOLUTION);
  return {
    id: `${prefix}-${attributes.RESOLUTION ?? attributes.BANDWIDTH}`,
    bitrate: Number(attributes.BANDWIDTH) || 0,
    playlistUrl: resolve(attributes.URI, baseUrl),
    ...(size !== null ? { width: size[0], height: size[1] } : {}),
  };
}

/**
 * Image playlists (Roku EXT-X-IMAGE-STREAM-INF) as one image track, one
 * rendition per playlist. RESOLUTION is the size of one tile. The grid is
 * known here only when the tag carries LAYOUT; otherwise it arrives with the
 * media playlist's EXT-X-TILES. The kernel schedules no image track; the
 * thumbnails stage reads it.
 */
function imageTrack(streams: readonly TagLine[], baseUrl: string): Track | null {
  const renditions: Rendition[] = [];
  for (const { attributes } of streams) {
    const base = uriStreamRendition(attributes, 'i', baseUrl);
    if (base === null || renditions.some((r) => r.id === base.id)) continue;
    const tiles = tileGridFrom(attributes);
    renditions.push({
      ...base,
      codecs: attributes.CODECS ?? null,
      mimeType: /png/i.test(attributes.CODECS ?? '') ? 'image/png' : 'image/jpeg',
      segments: [],
      ...(tiles !== null ? { tiles } : {}),
    });
  }
  const first = renditions[0];
  if (first === undefined) return null;
  return {
    id: 'image-main',
    contentType: 'image',
    mimeType: first.mimeType,
    protection: null,
    renditions,
  };
}

/**
 * I-frame playlists (RFC 8216 §4.3.4.3) as one video track with role
 * 'trick'. Their media playlists carry EXT-X-I-FRAMES-ONLY and byte ranges
 * into the normal segments. Normal playback never selects the track.
 */
function trickTrack(
  streams: readonly TagLine[],
  baseUrl: string,
  protection: ProtectionInfo | null,
): Track | null {
  const renditions: Rendition[] = [];
  for (const { attributes } of streams) {
    const base = uriStreamRendition(attributes, 't', baseUrl);
    if (base === null || renditions.some((r) => r.id === base.id)) continue;
    const pathway = attributes['PATHWAY-ID'];
    renditions.push({
      ...base,
      codecs: splitCodecs(attributes.CODECS).video,
      mimeType: 'video/mp4',
      segments: [],
      ...(pathway !== undefined ? { pathway } : {}),
    });
  }
  if (renditions.length === 0) return null;
  return {
    id: 'video-trick',
    contentType: 'video',
    mimeType: 'video/mp4',
    role: 'trick',
    protection,
    renditions,
  };
}

/** RFC 8216 §4.3.4.4: DATA-ID is required, with VALUE or URI, and an optional LANGUAGE. */
function sessionDataFrom(
  attributes: Readonly<Record<string, string>>,
  baseUrl: string,
): SessionData | null {
  const id = attributes['DATA-ID'];
  if (id === undefined) return null;
  return {
    id,
    ...(attributes.VALUE !== undefined ? { value: attributes.VALUE } : {}),
    ...(attributes.URI !== undefined ? { uri: resolve(attributes.URI, baseUrl) } : {}),
    ...(attributes.LANGUAGE !== undefined ? { lang: attributes.LANGUAGE } : {}),
  };
}

/** parse either playlist form into a Presentation. Never throws. */
export function parse(text: string, baseUrl: string): ParseResult {
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { presentation: null, error: manifestError('missing #EXTM3U') };
  }
  const lines = lex(text);
  const isMultivariant = lines.some(
    (line) => line.kind === 'tag' && line.name === 'EXT-X-STREAM-INF',
  );
  if (!isMultivariant) {
    // A bare media playlist is a valid source: one video track, one rendition.
    const media = parseMediaPlaylist(text, baseUrl);
    if (media.playlist === null) {
      return { presentation: null, error: media.error ?? manifestError('unparsable playlist') };
    }
    if (media.playlist.segments.length === 0) {
      return {
        presentation: null,
        error: {
          category: 'manifest',
          code: 'MANIFEST_EMPTY',
          fatal: true,
          recoverable: false,
          context: { reason: 'no variants and no segments' },
        },
      };
    }
    const duration = media.playlist.segments.reduce((sum, s) => sum + s.duration, 0);
    // A bare playlist has no CODECS to say audio or video, but a packed-audio
    // source names its segments .aac/.mp3/.ac3: an all-audio segment set is an
    // audio presentation, so the buffer is audio/mp4, not a video buffer that
    // would reject the AAC.
    const audioOnly = media.playlist.segments.every((s) =>
      /\.(aac|mp3|ac3|ec3|m4a)(\?|$)/i.test(s.url),
    );
    const contentType = audioOnly ? ('audio' as const) : ('video' as const);
    const mimeType = audioOnly ? 'audio/mp4' : 'video/mp4';
    const rendition: Rendition = {
      id: 'r-0',
      bitrate: 0,
      codecs: null,
      mimeType,
      segments: media.playlist.segments,
      ...(media.playlist.init !== null ? { init: media.playlist.init } : {}),
      ...(media.playlist.dateRanges !== undefined ? { dateRanges: media.playlist.dateRanges } : {}),
    };
    return {
      presentation: {
        id: baseUrl,
        isLive: !media.playlist.endlist,
        ...(media.playlist.endlist ? { duration } : {}),
        ...(media.playlist.endlist
          ? {}
          : {
              live: {
                updatePeriod: media.playlist.targetDuration || 4,
                ...(media.playlist.dateAnchor !== undefined
                  ? { dateAnchor: media.playlist.dateAnchor }
                  : {}),
              },
            }),
        periods: [
          {
            id: 'p0',
            start: 0,
            tracks: [
              {
                id: 'main',
                contentType,
                mimeType,
                protection: media.playlist.protection,
                renditions: [rendition],
              },
            ],
          },
        ],
        couplings: [],
      },
      error: null,
    };
  }

  // Multivariant: decompose variants, hoist media entries, record couplings.
  const mediaEntries: MediaEntry[] = [];
  const variants: Array<{ attributes: Readonly<Record<string, string>>; uri: string }> = [];
  const imageStreams: TagLine[] = [];
  const iframeStreams: TagLine[] = [];
  const sessionData: SessionData[] = [];
  let sessionProtection: ProtectionInfo | null = null;
  let steering: { serverUri: string; defaultPathway?: string } | undefined;
  let pendingStreamInf: TagLine | null = null;

  for (const line of lines) {
    if (line.kind === 'tag') {
      if (line.name === 'EXT-X-MEDIA') {
        mediaEntries.push({
          type: line.attributes.TYPE ?? '',
          groupId: line.attributes['GROUP-ID'] ?? '',
          name: line.attributes.NAME ?? '',
          attributes: line.attributes,
          uri: line.attributes.URI !== undefined ? resolve(line.attributes.URI, baseUrl) : null,
        });
      } else if (line.name === 'EXT-X-STREAM-INF') {
        pendingStreamInf = line;
      } else if (line.name === 'EXT-X-IMAGE-STREAM-INF') {
        imageStreams.push(line);
      } else if (line.name === 'EXT-X-I-FRAME-STREAM-INF') {
        iframeStreams.push(line);
      } else if (line.name === 'EXT-X-SESSION-DATA') {
        const entry = sessionDataFrom(line.attributes, baseUrl);
        if (entry !== null) sessionData.push(entry);
      } else if (line.name === 'EXT-X-SESSION-KEY') {
        sessionProtection = protectionFrom(line, baseUrl) ?? sessionProtection;
      } else if (line.name === 'EXT-X-CONTENT-STEERING') {
        const serverUri = line.attributes['SERVER-URI'];
        if (serverUri !== undefined) {
          steering = {
            serverUri: resolve(serverUri, baseUrl),
            ...(line.attributes['PATHWAY-ID'] !== undefined
              ? { defaultPathway: line.attributes['PATHWAY-ID'] }
              : {}),
          };
        }
      }
      continue;
    }
    if (pendingStreamInf !== null) {
      variants.push({ attributes: pendingStreamInf.attributes, uri: resolve(line.uri, baseUrl) });
      pendingStreamInf = null;
    }
  }

  if (variants.length === 0) {
    return { presentation: null, error: manifestError('multivariant playlist with no variants') };
  }

  const renditions: Rendition[] = [];
  const audioOnlyVariants: typeof variants = [];
  const couplings: Coupling[] = [];
  const declared = new Map<string, Readonly<Record<string, string>>>();
  for (const variant of variants) {
    const bandwidth = Number(variant.attributes.BANDWIDTH) || 0;
    const [width, height] = dimensions(variant.attributes.RESOLUTION) ?? [];
    const { video, audio } = splitCodecs(variant.attributes.CODECS);
    // A STREAM-INF whose CODECS names an audio codec but no video codec is an
    // audio-only rendition, not a low-bitrate video one. When the stream also
    // has video (Apple's bipbop, Unified's Tears of Steel list one at the
    // lowest bandwidth), it must not join the video track: the no-abr default
    // picks the lowest bitrate and would open a video buffer with no codec,
    // which Chrome refuses. When the whole presentation is audio (a radio or
    // DVR audio stream), these variants are the presentation, so keep them
    // aside and promote them to an audio track if no video variant appears.
    if (video === null && audio !== null) {
      audioOnlyVariants.push(variant);
      continue;
    }
    // When the variant carries no separate audio group its segments are
    // muxed, so the transmux emits one fMP4 with both tracks and the buffer
    // must declare both codecs. With an audio group the audio is a separate
    // buffer and only the video codec belongs here.
    const hasAudioGroup = variant.attributes.AUDIO !== undefined;
    const codecs =
      video !== null && !hasAudioGroup && audio !== null ? `${video}, ${audio}` : video;
    const frameRate = Number(variant.attributes['FRAME-RATE']);
    // RFC 8216bis §4.4.6.2; a Dolby Vision codec without it is PQ.
    const range = variant.attributes['VIDEO-RANGE'];
    const videoRange =
      range === 'SDR' || range === 'PQ' || range === 'HLG'
        ? range
        : video !== null && /^dv(h1|he|a1|av)/.test(video)
          ? 'PQ'
          : undefined;
    const pathway = variant.attributes['PATHWAY-ID'];
    let id = pathway !== undefined ? `v-${bandwidth}-${pathway}` : `v-${bandwidth}`;
    const taken = declared.get(id);
    if (taken !== undefined) {
      // RFC 8216 §6.2.3: a repeated variant with another URI is a backup
      // copy of the same stream, which the engine does not fail over to.
      // A variant that differs in anything else is another stream with the
      // same BANDWIDTH, and gets its own id.
      if (attributeKey(taken) === attributeKey(variant.attributes)) continue;
      id = `${id}-${renditions.length}`;
    }
    declared.set(id, variant.attributes);
    const average = Number(variant.attributes['AVERAGE-BANDWIDTH']);
    const supplemental = variant.attributes['SUPPLEMENTAL-CODECS'];
    renditions.push({
      id,
      bitrate: bandwidth,
      codecs,
      mimeType: 'video/mp4',
      segments: [],
      playlistUrl: variant.uri,
      ...(average > 0 ? { averageBitrate: average } : {}),
      ...(supplemental !== undefined ? { supplementalCodecs: supplemental } : {}),
      ...(pathway !== undefined ? { pathway } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(Number.isFinite(frameRate) ? { frameRate } : {}),
      ...(videoRange !== undefined ? { videoRange } : {}),
    });
    const requires: Record<string, string> = {};
    if (variant.attributes.AUDIO !== undefined) requires.audio = variant.attributes.AUDIO;
    if (variant.attributes.SUBTITLES !== undefined) requires.text = variant.attributes.SUBTITLES;
    if (Object.keys(requires).length > 0) {
      couplings.push({ renditionId: id, requires });
    }
  }

  const tracks: Track[] = [];
  if (renditions.length > 0) {
    tracks.push({
      id: 'video-main',
      contentType: 'video',
      mimeType: 'video/mp4',
      protection: sessionProtection,
      renditions,
    });
  } else if (audioOnlyVariants.length > 0) {
    // Pure audio presentation: the STREAM-INF variants are the audio
    // renditions and there is no video track.
    const audioRenditions: Rendition[] = [];
    for (const variant of audioOnlyVariants) {
      const bandwidth = Number(variant.attributes.BANDWIDTH) || 0;
      const id = `a-${bandwidth}`;
      if (audioRenditions.some((r) => r.id === id)) continue;
      const { audio } = splitCodecs(variant.attributes.CODECS);
      audioRenditions.push({
        id,
        bitrate: bandwidth,
        codecs: audio,
        mimeType: 'audio/mp4',
        segments: [],
        playlistUrl: variant.uri,
      });
    }
    tracks.push({
      id: 'audio-main',
      contentType: 'audio',
      mimeType: 'audio/mp4',
      protection: sessionProtection,
      renditions: audioRenditions,
    });
  }

  const soundtracks = new Map<string, { groups: Set<string>; renditions: Rendition[] }>();
  for (const entry of mediaEntries) {
    const caption = captionTrack(entry);
    if (caption !== null) {
      tracks.push(caption);
      continue;
    }
    const contentType = mediaContentType(entry.type);
    if (contentType === null || entry.uri === null) continue;
    const { audio } = splitCodecs(
      variants.find((v) => v.attributes.AUDIO === entry.groupId)?.attributes.CODECS,
    );
    // Subtitles are WebVTT files unless the variants name a subtitle codec
    // in fMP4 (stpp for IMSC, wvtt), which a stage parses by codec family.
    const { text } = splitCodecs(
      variants.find((v) => v.attributes.SUBTITLES === entry.groupId)?.attributes.CODECS,
    );
    const mimeType =
      contentType === 'audio' ? 'audio/mp4' : text !== null ? 'application/mp4' : 'text/vtt';
    const rendition: Rendition = {
      id: `${entry.groupId}:${entry.name}`,
      bitrate: 0,
      codecs: contentType === 'audio' ? audio : text,
      mimeType,
      segments: [],
      playlistUrl: entry.uri,
      ...channelsOf(entry),
    };
    // The same soundtrack in another audio group (AAC stereo in one, AC-3
    // 5.1 in the next) joins the track already made for it, as one more
    // rendition: a viewer picks the soundtrack, the kernel the encoding.
    // A track takes one rendition per group, so two members of one group
    // stay two tracks.
    const key = attributeKey(entry.attributes, PER_GROUP);
    const twin = contentType === 'audio' ? soundtracks.get(key) : undefined;
    if (twin !== undefined && !twin.groups.has(entry.groupId)) {
      twin.groups.add(entry.groupId);
      twin.renditions.push(rendition);
      continue;
    }
    const renditions = [rendition];
    if (contentType === 'audio')
      soundtracks.set(key, { groups: new Set([entry.groupId]), renditions });
    const characteristics = characteristicsOf(entry);
    tracks.push({
      id: `${entry.groupId}:${entry.name}`,
      contentType,
      mimeType,
      name: entry.name,
      ...(entry.attributes.AUTOSELECT === 'YES' ? { autoselect: true } : {}),
      protection: sessionProtection,
      ...(entry.attributes.LANGUAGE !== undefined ? { lang: entry.attributes.LANGUAGE } : {}),
      ...(entry.attributes.DEFAULT === 'YES' ? { role: 'main' } : { role: 'alternate' }),
      ...(characteristics.length > 0 ? { characteristics } : {}),
      // RFC 8216bis §4.4.6.1: FORCED is valid on SUBTITLES only.
      ...(contentType === 'text' && entry.attributes.FORCED === 'YES' ? { forced: true } : {}),
      renditions,
    });
  }

  const trick = trickTrack(iframeStreams, baseUrl, sessionProtection);
  if (trick !== null) tracks.push(trick);
  const images = imageTrack(imageStreams, baseUrl);
  if (images !== null) tracks.push(images);

  return {
    presentation: {
      id: baseUrl,
      // The variant playlist itself says nothing about liveness; the media
      // playlist's ENDLIST decides. Assume VOD until a merge says otherwise.
      isLive: false,
      periods: [{ id: 'p0', start: 0, tracks }],
      couplings,
      ...(steering !== undefined ? { steering } : {}),
      ...(sessionData.length > 0 ? { sessionData } : {}),
    },
    error: null,
  };
}

/**
 * The presentation-time shift that puts a refreshed live window back on the
 * timeline the previous window established. parseMediaPlaylist numbers every
 * window from zero, but playback needs one stable seq->time map across
 * reloads: without it a sliding window keeps handing the newest segment the
 * same low start, the buffer never advances past the first window, and live
 * stalls with no recovery. The media sequence number shared by the old and new
 * window fixes the offset; a fresh load (no prior segments) shifts by zero.
 */
function timelineShift(previous: SegmentAddressing, next: readonly Segment[]): number {
  if (!Array.isArray(previous) || previous.length === 0 || next.length === 0) return 0;
  const prior = previous as readonly Segment[];
  const startBySeq = new Map(prior.map((s) => [s.seq, s.start]));
  for (const segment of next) {
    const priorStart = startBySeq.get(segment.seq);
    if (priorStart !== undefined) return priorStart - segment.start;
  }
  // No shared sequence: the window slid entirely past what this rendition
  // had, as happens to a rendition fetched at startup and reloaded only
  // once a switch made it active. Extrapolate along the sequence numbers at
  // the average segment duration (the playlist sync strategy in
  // videojs-http-streaming), instead of restarting the rendition at zero
  // and pulling the live window back to the beginning of time.
  const last = prior[prior.length - 1] as Segment;
  const first = next[0] as Segment;
  const average = prior.reduce((sum, s) => sum + s.duration, 0) / prior.length;
  return last.start + (first.seq - last.seq) * average - first.start;
}

/**
 * The PLAYLIST_REFRESHED fact that merges a fetched media playlist into the
 * rendition that referenced it, or null when the playlist is older than
 * what the rendition holds. On a live refresh the new window is rebased
 * onto the running timeline first, so segment start times stay absolute
 * across reloads. The kernel merges the fact into the presentation it
 * holds when the fact lands (applyRefresh).
 */
export function refreshFor(
  presentation: Presentation,
  renditionId: string,
  playlist: MediaPlaylist,
): PlaylistRefresh | null {
  let previous: SegmentAddressing = [];
  // A live rendition loaded for the first time mid-stream has no window of
  // its own to rebase onto. A sibling in the same track does: the ladder
  // shares media sequence numbers, so the sibling's window places this one
  // on the running timeline. A VOD rendition needs no such anchor, and its
  // siblings may cut segments at other boundaries.
  let sibling: readonly Segment[] = [];
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      if (!track.renditions.some((r) => r.id === renditionId)) continue;
      for (const rendition of track.renditions) {
        if (rendition.id === renditionId) {
          previous = rendition.segments;
        } else if (Array.isArray(rendition.segments) && rendition.segments.length > 0) {
          const candidate = rendition.segments as readonly Segment[];
          const newest = (list: readonly Segment[]) => list[list.length - 1]?.seq ?? -1;
          if (newest(candidate) > newest(sibling)) sibling = candidate;
        }
      }
    }
  }
  // A reload older than what is already known (a CDN edge behind another)
  // must not pull the rendition's window backwards; keep the newer list.
  const knownLast = Array.isArray(previous) ? previous[previous.length - 1] : undefined;
  const incomingLast = playlist.segments[playlist.segments.length - 1];
  if (
    knownLast !== undefined &&
    incomingLast !== undefined &&
    !playlist.endlist &&
    incomingLast.seq < knownLast.seq
  ) {
    return null;
  }
  const anchor =
    !playlist.endlist && knownLast === undefined && sibling.length > 0 ? sibling : previous;
  const shift = timelineShift(anchor, playlist.segments);
  const segments =
    shift === 0
      ? playlist.segments
      : playlist.segments.map((s) => ({ ...s, start: s.start + shift }));
  return {
    type: 'PLAYLIST_REFRESHED',
    trackId: renditionId,
    renditionId,
    mediaSequence: playlist.mediaSequence,
    segments,
    ...(playlist.init !== null ? { init: playlist.init } : {}),
    ...(playlist.tiles !== undefined ? { tiles: playlist.tiles } : {}),
    protection: playlist.protection,
    endlist: playlist.endlist,
    ...(playlist.endlist ? {} : { updatePeriod: playlist.targetDuration || 4 }),
    ...(playlist.dateAnchor !== undefined
      ? {
          dateAnchor: {
            wallClock: playlist.dateAnchor.wallClock,
            presentationTime: playlist.dateAnchor.presentationTime + shift,
          },
        }
      : {}),
    // Date ranges ride the same shift as the segments they are anchored to.
    ...(playlist.dateRanges !== undefined
      ? {
          dateRanges:
            shift === 0
              ? playlist.dateRanges
              : playlist.dateRanges.map((range) => shiftRange(range, shift)),
        }
      : {}),
  };
}

function shiftRange(range: DateRange, shift: number): DateRange {
  return {
    ...range,
    start: range.start + shift,
    ...(range.end !== undefined ? { end: range.end + shift } : {}),
    ...(range.plannedEnd !== undefined ? { plannedEnd: range.plannedEnd + shift } : {}),
  };
}

/** Immutably merges a fetched media playlist into the rendition that referenced it. */
export function mergePlaylist(
  presentation: Presentation,
  renditionId: string,
  playlist: MediaPlaylist,
): Presentation {
  const refresh = refreshFor(presentation, renditionId, playlist);
  if (refresh === null) return presentation;
  return applyRefresh(presentation, refresh) ?? presentation;
}
