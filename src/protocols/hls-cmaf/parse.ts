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
import type { MatteboxError } from '../../types/error.js';
import type {
  ByteRange,
  Coupling,
  Presentation,
  ProtectionInfo,
  Rendition,
  Segment,
  SegmentAddressing,
  SegmentKey,
  SegmentRef,
  Track,
} from '../../types/ir.js';
import type { TagLine } from './lexer.js';
import { lex } from './lexer.js';

export interface ParseResult {
  readonly presentation: Presentation | null;
  readonly error: MatteboxError | null;
}

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
}

export interface MediaPlaylistResult {
  readonly playlist: MediaPlaylist | null;
  readonly error: MatteboxError | null;
}

function manifestError(reason: string): MatteboxError {
  return {
    category: 'manifest',
    code: 'MANIFEST_PARSE_FAILED',
    fatal: true,
    recoverable: false,
    context: { reason },
  };
}

function resolve(uri: string, baseUrl: string): string {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

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
  const hex = (n: number) => (Number(n) & 0xff).toString(16).padStart(2, '0');
  return `${match[1]}.${hex(Number(match[2]))}00${hex(Number(match[3]))}`;
}

function splitCodecs(value: string | undefined): { video: string | null; audio: string | null } {
  if (value === undefined) return { video: null, audio: null };
  let video: string | null = null;
  let audio: string | null = null;
  for (const codec of value.split(',').map((c) => c.trim())) {
    if (codec === '') continue;
    if (AUDIO_CODECS.test(codec)) {
      audio = audio ?? codec;
    } else {
      video = video ?? normalizeAvcCodec(codec);
    }
  }
  return { video, audio };
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

  let dateAnchor: { wallClock: number; presentationTime: number } | undefined;
  let pendingDate: number | null = null;
  let pendingDuration: number | null = null;
  let pendingRange: ByteRange | null = null;
  let pendingDiscontinuity = false;
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
    segments.push({
      seq,
      start,
      duration: pendingDuration,
      url: resolve(line.uri, baseUrl),
      ...(pendingRange !== null ? { byteRange: pendingRange } : {}),
      ...(pendingDiscontinuity ? { discontinuity: true } : {}),
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
      // EXT-X-I-FRAME-STREAM-INF is recognized and skipped; thumbnails later.
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
  for (const variant of variants) {
    const bandwidth = Number(variant.attributes.BANDWIDTH) || 0;
    const resolution = variant.attributes.RESOLUTION;
    const [width, height] =
      resolution !== undefined ? resolution.split('x').map((n) => Number(n)) : [];
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
    const pathway = variant.attributes['PATHWAY-ID'];
    const id = pathway !== undefined ? `v-${bandwidth}-${pathway}` : `v-${bandwidth}`;
    if (renditions.some((r) => r.id === id)) continue;
    renditions.push({
      id,
      bitrate: bandwidth,
      codecs,
      mimeType: 'video/mp4',
      segments: [],
      playlistUrl: variant.uri,
      ...(pathway !== undefined ? { pathway } : {}),
      ...(width !== undefined && Number.isFinite(width) ? { width } : {}),
      ...(height !== undefined && Number.isFinite(height) ? { height } : {}),
      ...(Number.isFinite(frameRate) ? { frameRate } : {}),
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

  for (const entry of mediaEntries) {
    const contentType = mediaContentType(entry.type);
    if (contentType === null || entry.uri === null) continue;
    const { audio } = splitCodecs(
      variants.find((v) => v.attributes.AUDIO === entry.groupId)?.attributes.CODECS,
    );
    const mimeType = contentType === 'audio' ? 'audio/mp4' : 'text/vtt';
    tracks.push({
      id: `${entry.groupId}:${entry.name}`,
      contentType,
      mimeType,
      protection: sessionProtection,
      ...(entry.attributes.LANGUAGE !== undefined ? { lang: entry.attributes.LANGUAGE } : {}),
      ...(entry.attributes.DEFAULT === 'YES' ? { role: 'main' } : { role: 'alternate' }),
      renditions: [
        {
          id: `${entry.groupId}:${entry.name}`,
          bitrate: 0,
          codecs: contentType === 'audio' ? audio : null,
          mimeType,
          segments: [],
          playlistUrl: entry.uri,
        },
      ],
    });
  }

  return {
    presentation: {
      id: baseUrl,
      // The variant playlist itself says nothing about liveness; the media
      // playlist's ENDLIST decides. Assume VOD until a merge says otherwise.
      isLive: false,
      periods: [{ id: 'p0', start: 0, tracks }],
      couplings,
      ...(steering !== undefined ? { steering } : {}),
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
 * Immutably merges a fetched media playlist into the rendition that
 * referenced it. Duration, liveness, init, and protection all come from
 * the media playlist; the presentation learns them here. On a live refresh
 * the new window is rebased onto the running timeline first, so segment start
 * times stay absolute across reloads.
 */
export function mergePlaylist(
  presentation: Presentation,
  renditionId: string,
  playlist: MediaPlaylist,
): Presentation {
  let previous: SegmentAddressing = [];
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.id === renditionId) previous = rendition.segments;
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
    return presentation;
  }
  const shift = timelineShift(previous, playlist.segments);
  const segments =
    shift === 0
      ? playlist.segments
      : playlist.segments.map((s) => ({ ...s, start: s.start + shift }));
  const duration = segments.reduce((sum, s) => sum + s.duration, 0);
  const dateAnchor =
    playlist.dateAnchor !== undefined
      ? {
          wallClock: playlist.dateAnchor.wallClock,
          presentationTime: playlist.dateAnchor.presentationTime + shift,
        }
      : undefined;
  const periods = presentation.periods.map((period) => ({
    ...period,
    tracks: period.tracks.map((track) => {
      if (!track.renditions.some((r) => r.id === renditionId)) return track;
      return {
        ...track,
        protection: track.protection ?? playlist.protection,
        renditions: track.renditions.map((rendition) =>
          rendition.id === renditionId
            ? {
                ...rendition,
                segments,
                ...(playlist.init !== null ? { init: playlist.init } : {}),
              }
            : rendition,
        ),
      };
    }),
  }));
  const knownDuration = presentation.duration ?? 0;
  return {
    ...presentation,
    isLive: !playlist.endlist,
    ...(playlist.endlist ? { duration: Math.max(knownDuration, duration) } : {}),
    ...(playlist.endlist
      ? {}
      : {
          live: {
            ...presentation.live,
            updatePeriod: playlist.targetDuration || 4,
            ...(dateAnchor !== undefined ? { dateAnchor } : {}),
          },
        }),
    periods,
  };
}
