/**
 * Manifest checks: the problems a playlist or MPD carries that the parser
 * alone does not report. Missing tags the spec requires, codecs this
 * browser cannot decode, DRM it cannot use, durations that break the
 * rules. Text checks read the raw manifest; capability checks read the
 * parsed presentation and ask the platform.
 */

import type { MatteboxError, Presentation } from '../../src/index.js';
import type { MediaPlaylist } from '../../src/protocols/hls-cmaf/parse.js';

export type CheckLevel = 'error' | 'warn' | 'info' | 'ok';

export interface Check {
  readonly level: CheckLevel;
  readonly message: string;
  /** What to do about it, in one sentence. */
  readonly hint?: string;
}

export type ParsedManifest =
  | {
      readonly kind: 'hls-master';
      readonly presentation: Presentation | null;
      readonly error: MatteboxError | null;
    }
  | {
      readonly kind: 'hls-media';
      readonly playlist: MediaPlaylist | null;
      readonly error: MatteboxError | null;
    }
  | {
      readonly kind: 'dash';
      readonly presentation: Presentation | null;
      readonly error: MatteboxError | null;
    };

const KEY_SYSTEMS: Record<string, { name: string; keySystem: string }> = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': { name: 'Widevine', keySystem: 'com.widevine.alpha' },
  '9a04f079-9840-4286-ab92-e65be0885f95': {
    name: 'PlayReady',
    keySystem: 'com.microsoft.playready',
  },
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': { name: 'FairPlay', keySystem: 'com.apple.fps' },
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': { name: 'ClearKey', keySystem: 'org.w3.clearkey' },
  'e2719d58-a985-b3c9-781a-b030af78d30e': { name: 'ClearKey', keySystem: 'org.w3.clearkey' },
};

function mseSupports(type: string): boolean {
  try {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type);
  } catch {
    return false;
  }
}

async function keySystemAvailable(keySystem: string): Promise<boolean> {
  if (typeof navigator.requestMediaKeySystemAccess !== 'function') return false;
  try {
    await navigator.requestMediaKeySystemAccess(keySystem, [
      {
        initDataTypes: ['cenc', 'keyids', 'sinf', 'skd'],
        videoCapabilities: [
          { contentType: 'video/mp4; codecs="avc1.42e01e"' },
          { contentType: 'video/mp4; codecs="vp09.00.10.08"' },
        ],
        audioCapabilities: [
          { contentType: 'audio/mp4; codecs="mp4a.40.2"' },
          { contentType: 'audio/mp4; codecs="opus"' },
        ],
      },
    ]);
    return true;
  } catch {
    return false;
  }
}

function tagLines(text: string, tag: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.startsWith(tag));
}

function attrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = line.slice(line.indexOf(':') + 1);
  for (const match of body.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) {
    out[match[1] as string] = match[3] ?? (match[2] as string);
  }
  return out;
}

// ---- HLS master -------------------------------------------------------------

function checkHlsMasterText(text: string): Check[] {
  const checks: Check[] = [];
  if (!text.trimStart().startsWith('#EXTM3U')) {
    checks.push({ level: 'error', message: 'The playlist does not start with #EXTM3U.' });
  }
  if (tagLines(text, '#EXT-X-VERSION').length === 0) {
    checks.push({
      level: 'info',
      message: 'No #EXT-X-VERSION tag; the playlist is read as version 1.',
      hint: 'Declare the version when using features from later versions (fMP4, byte ranges, EXT-X-MAP).',
    });
  }
  if (tagLines(text, '#EXT-X-INDEPENDENT-SEGMENTS').length === 0) {
    checks.push({
      level: 'info',
      message:
        'No #EXT-X-INDEPENDENT-SEGMENTS; quality switches rely on every segment starting with a keyframe anyway.',
    });
  }
  const variants = tagLines(text, '#EXT-X-STREAM-INF');
  if (variants.length === 0) {
    checks.push({ level: 'error', message: 'No #EXT-X-STREAM-INF variants found.' });
  }
  const media = tagLines(text, '#EXT-X-MEDIA').map(attrs);
  const groups = new Set(media.map((m) => `${m.TYPE}:${m['GROUP-ID']}`));
  let missingCodecs = 0;
  let missingResolution = 0;
  for (const line of variants) {
    const a = attrs(line);
    if (a.BANDWIDTH === undefined) {
      checks.push({
        level: 'error',
        message: `A variant has no BANDWIDTH attribute (${line.slice(0, 60)}…).`,
        hint: 'BANDWIDTH is required by RFC 8216 §4.3.4.2; without it ABR cannot rank the variant.',
      });
    }
    if (a.CODECS === undefined) missingCodecs += 1;
    if (a.RESOLUTION === undefined && a.CODECS?.includes('avc1') !== false) missingResolution += 1;
    for (const key of ['AUDIO', 'SUBTITLES', 'VIDEO', 'CLOSED-CAPTIONS'] as const) {
      const ref = a[key];
      if (ref !== undefined && ref !== 'NONE' && !groups.has(`${key}:${ref}`)) {
        checks.push({
          level: 'error',
          message: `A variant references ${key} group "${ref}" but no #EXT-X-MEDIA declares it.`,
        });
      }
    }
  }
  if (missingCodecs > 0) {
    checks.push({
      level: 'warn',
      message: `${missingCodecs} of ${variants.length} variants have no CODECS attribute.`,
      hint: 'The engine must probe the first segment to learn the codec, which delays startup and can fail on TS content.',
    });
  }
  if (missingResolution > 0 && missingResolution === variants.length) {
    checks.push({
      level: 'info',
      message:
        'No variant declares RESOLUTION; height caps and the size-based ABR cap cannot apply.',
    });
  }
  const audioNoUri = media.filter((m) => m.TYPE === 'AUDIO' && m.URI === undefined);
  if (audioNoUri.length > 0) {
    checks.push({
      level: 'info',
      message: `${audioNoUri.length} audio rendition(s) have no URI: their audio is muxed into the video segments.`,
    });
  }
  const keys = tagLines(text, '#EXT-X-SESSION-KEY').map(attrs);
  for (const key of keys) checks.push(...keyMethodChecks(key.METHOD ?? '', key.KEYFORMAT));
  return checks;
}

function keyMethodChecks(method: string, keyFormat: string | undefined): Check[] {
  if (method === 'NONE' || method === '') return [];
  if (method === 'AES-128') {
    return [
      {
        level: 'error',
        message:
          'Segments use AES-128 whole-segment encryption, which the engine does not decrypt.',
        hint: 'Use SAMPLE-AES with a DRM key system, or serve the content in the clear.',
      },
    ];
  }
  if (method === 'SAMPLE-AES' || method === 'SAMPLE-AES-CTR') {
    const format = keyFormat ?? 'identity';
    return [
      {
        level: 'info',
        message: `Segments use ${method} with KEYFORMAT ${format}; a matching DRM stage and key system are needed.`,
      },
    ];
  }
  return [{ level: 'warn', message: `Unknown EXT-X-KEY METHOD "${method}".` }];
}

// ---- HLS media playlist -----------------------------------------------------

function checkHlsMediaText(text: string, playlist: MediaPlaylist | null): Check[] {
  const checks: Check[] = [];
  if (tagLines(text, '#EXT-X-TARGETDURATION').length === 0) {
    checks.push({
      level: 'error',
      message: 'No #EXT-X-TARGETDURATION tag.',
      hint: 'Required by RFC 8216 §4.3.3.1; live refresh timing and stall detection depend on it.',
    });
  }
  const endlist = tagLines(text, '#EXT-X-ENDLIST').length > 0;
  const type = tagLines(text, '#EXT-X-PLAYLIST-TYPE')[0]?.split(':')[1]?.trim();
  if (!endlist) {
    checks.push({
      level: 'info',
      message: `Live playlist (no #EXT-X-ENDLIST)${type ? `, type ${type}` : ''}; the engine refreshes it every target duration.`,
    });
    if (tagLines(text, '#EXT-X-MEDIA-SEQUENCE').length === 0) {
      checks.push({
        level: 'warn',
        message:
          'Live playlist without #EXT-X-MEDIA-SEQUENCE; segments are assumed to start at sequence 0.',
        hint: 'Sliding windows need the media sequence to line up refreshes.',
      });
    }
  }
  const map = tagLines(text, '#EXT-X-MAP').length > 0;
  const fmp4 = /\.(m4s|mp4|m4v|m4a|cmfv|cmfa)(\?|$)/im.test(text);
  if (fmp4 && !map) {
    checks.push({
      level: 'warn',
      message: 'Segments look like fMP4 but there is no #EXT-X-MAP initialization segment.',
      hint: 'Without an init segment the SourceBuffer cannot be configured; a self-initializing segment is the only other option.',
    });
  }
  if (playlist !== null) {
    const over = playlist.segments.filter((s) => Math.round(s.duration) > playlist.targetDuration);
    if (over.length > 0) {
      checks.push({
        level: 'warn',
        message: `${over.length} segment(s) are longer than the target duration (${playlist.targetDuration}s) once rounded.`,
        hint: 'RFC 8216 §4.3.3.1 requires every EXTINF to be at most the target duration when rounded to an integer.',
      });
    }
    const discontinuities = playlist.segments.filter((s) => s.discontinuity === true).length;
    if (discontinuities > 0) {
      checks.push({
        level: 'info',
        message: `${discontinuities} discontinuit${discontinuities === 1 ? 'y' : 'ies'}; timestamps restart there and the engine re-anchors the timeline.`,
      });
    }
    const total = playlist.segments.reduce((n, s) => n + s.duration, 0);
    checks.push({
      level: 'ok',
      message: `${playlist.segments.length} segments, ${total.toFixed(1)}s in total, target duration ${playlist.targetDuration}s.`,
    });
  }
  const gaps = tagLines(text, '#EXT-X-GAP').length;
  if (gaps > 0) {
    checks.push({
      level: 'warn',
      message: `${gaps} segment(s) are marked #EXT-X-GAP (missing content); playback must skip them.`,
    });
  }
  if (tagLines(text, '#EXT-X-PROGRAM-DATE-TIME').length > 0) {
    checks.push({
      level: 'ok',
      message: 'Program date time is present; wall-clock seeking is possible.',
    });
  }
  for (const key of tagLines(text, '#EXT-X-KEY').map(attrs)) {
    checks.push(...keyMethodChecks(key.METHOD ?? '', key.KEYFORMAT));
  }
  return dedupe(checks);
}

// ---- DASH --------------------------------------------------------------------

function checkDashText(text: string): Check[] {
  const checks: Check[] = [];
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const mpd = doc.querySelector('MPD');
  if (mpd === null) {
    checks.push({ level: 'error', message: 'No <MPD> root element; this is not an MPD.' });
    return checks;
  }
  const dynamic = mpd.getAttribute('type') === 'dynamic';
  if (mpd.getAttribute('profiles') === null) {
    checks.push({
      level: 'info',
      message: 'No @profiles on <MPD>; players cannot tell which DASH profile applies.',
    });
  }
  if (dynamic) {
    if (mpd.getAttribute('availabilityStartTime') === null) {
      checks.push({
        level: 'error',
        message: 'A dynamic MPD needs @availabilityStartTime to place segments on the wall clock.',
      });
    }
    if (mpd.getAttribute('minimumUpdatePeriod') === null) {
      checks.push({
        level: 'warn',
        message: 'Dynamic MPD without @minimumUpdatePeriod; the engine will not refresh it.',
      });
    }
    if (doc.querySelector('UTCTiming') === null) {
      checks.push({
        level: 'info',
        message:
          'No <UTCTiming>; the live edge is computed from the local clock, which may drift from the server.',
      });
    }
  } else if (mpd.getAttribute('mediaPresentationDuration') === null) {
    checks.push({
      level: 'warn',
      message: 'Static MPD without @mediaPresentationDuration; the duration is unknown.',
    });
  }
  const periods = doc.querySelectorAll('Period');
  if (periods.length === 0) checks.push({ level: 'error', message: 'No <Period> in the MPD.' });
  if (periods.length > 1) {
    checks.push({
      level: 'info',
      message: `${periods.length} periods; the engine stitches them on one timeline.`,
    });
  }
  for (const set of doc.querySelectorAll('AdaptationSet')) {
    const reps = set.querySelectorAll('Representation');
    const mime = set.getAttribute('mimeType') ?? reps[0]?.getAttribute('mimeType');
    const codecs = set.getAttribute('codecs') ?? reps[0]?.getAttribute('codecs');
    if (mime === null || mime === undefined) {
      checks.push({
        level: 'warn',
        message: 'An AdaptationSet declares no mimeType on itself or its representations.',
      });
    }
    if ((codecs === null || codecs === undefined) && mime?.startsWith('video') === true) {
      checks.push({
        level: 'warn',
        message:
          'A video AdaptationSet declares no codecs; the SourceBuffer type cannot be built from the MPD.',
      });
    }
    const template =
      set.querySelector('SegmentTemplate') ?? reps[0]?.querySelector('SegmentTemplate');
    const base = set.querySelector('SegmentBase') ?? reps[0]?.querySelector('SegmentBase');
    const list = set.querySelector('SegmentList') ?? reps[0]?.querySelector('SegmentList');
    if (template === null && base === null && list === null) {
      checks.push({
        level: 'warn',
        message:
          'An AdaptationSet has no SegmentTemplate, SegmentBase, or SegmentList; single-file BaseURL addressing is assumed.',
      });
    }
    if (
      template !== null &&
      template !== undefined &&
      template.getAttribute('initialization') === null &&
      !set.querySelector('Initialization')
    ) {
      checks.push({
        level: 'warn',
        message: 'A SegmentTemplate has no @initialization; the init segment cannot be addressed.',
      });
    }
  }
  return dedupe(checks);
}

// ---- capability checks over the parsed presentation --------------------------

async function checkPresentation(presentation: Presentation): Promise<Check[]> {
  const checks: Check[] = [];
  const tracks = presentation.periods.flatMap((p) => p.tracks);
  for (const contentType of ['video', 'audio'] as const) {
    const renditions = tracks
      .filter((t) => t.contentType === contentType)
      .flatMap((t) => t.renditions.map((r) => ({ track: t, rendition: r })));
    if (renditions.length === 0) continue;
    const unsupported = renditions.filter(({ track, rendition }) => {
      if (rendition.codecs === null) return false;
      // TS and packed audio are transmuxed to fMP4 before the SourceBuffer, so the
      // MP4 container is what the browser must accept.
      const container = `${contentType}/${track.mimeType.includes('webm') ? 'webm' : 'mp4'}`;
      return !mseSupports(`${container}; codecs="${rendition.codecs}"`);
    });
    const undeclared = renditions.filter(({ rendition }) => rendition.codecs === null).length;
    if (unsupported.length === renditions.length) {
      checks.push({
        level: 'error',
        message: `No ${contentType} rendition is decodable here: ${[...new Set(unsupported.map((u) => u.rendition.codecs))].join(', ')}.`,
        hint: 'See the Browser support tab. A Chromium without proprietary codecs cannot decode H.264 or AAC.',
      });
    } else if (unsupported.length > 0) {
      checks.push({
        level: 'warn',
        message: `${unsupported.length} of ${renditions.length} ${contentType} renditions use codecs this browser cannot decode (${[...new Set(unsupported.map((u) => u.rendition.codecs))].join(', ')}); they are filtered out.`,
      });
    } else {
      checks.push({
        level: 'ok',
        message: `All ${renditions.length} ${contentType} rendition(s) are decodable here${undeclared > 0 ? `, ${undeclared} with no declared codec` : ''}.`,
      });
    }
  }
  const schemes = tracks.flatMap((t) => t.protection?.schemes ?? []);
  if (schemes.length > 0) {
    const systems = new Map<string, string | null>();
    for (const s of schemes) {
      if (s.systemId !== null) systems.set(s.systemId.toLowerCase(), s.scheme);
      else systems.set(`method:${s.scheme ?? 'unknown'}`, s.scheme);
    }
    for (const [id, scheme] of systems) {
      const known = KEY_SYSTEMS[id];
      if (known === undefined) {
        checks.push({
          level: id.startsWith('method:') ? 'info' : 'warn',
          message: id.startsWith('method:')
            ? `Content protection is signaled by method ${scheme ?? 'unknown'} without a key system UUID.`
            : `Content protection uses an unknown key system ${id}.`,
        });
        continue;
      }
      const available = await keySystemAvailable(known.keySystem);
      checks.push({
        level: available ? 'ok' : 'error',
        message: `${known.name}${scheme ? ` (${scheme})` : ''} protection: ${available ? 'this browser can open it' : 'this browser cannot open it'}.`,
        ...(available
          ? {}
          : { hint: 'Choose a browser with that CDM, or another resource of the same content.' }),
      });
    }
    const withoutInitData = schemes.filter(
      (s) => s.initData === null && s.systemId !== null,
    ).length;
    if (withoutInitData === schemes.length) {
      checks.push({
        level: 'info',
        message:
          'No pssh init data in the manifest; the key session opens from the media’s encrypted event instead.',
      });
    }
  } else {
    checks.push({ level: 'ok', message: 'No content protection; the stream plays in the clear.' });
  }
  const text = tracks.filter((t) => t.contentType === 'text');
  const unsupportedText = text.filter((t) => !/vtt|webvtt|ttml|imsc|cea|608|708/i.test(t.mimeType));
  if (unsupportedText.length > 0) {
    checks.push({
      level: 'info',
      message: `${unsupportedText.length} text track(s) use ${[...new Set(unsupportedText.map((t) => t.mimeType))].join(', ')}, which no text stage handles.`,
    });
  }
  return checks;
}

function dedupe(checks: Check[]): Check[] {
  const seen = new Set<string>();
  return checks.filter((c) => {
    if (seen.has(c.message)) return false;
    seen.add(c.message);
    return true;
  });
}

export async function checkManifest(text: string, parsed: ParsedManifest): Promise<Check[]> {
  const checks: Check[] = [];
  if (parsed.error !== null) {
    const reason = (parsed.error.context as { reason?: string } | undefined)?.reason;
    checks.push({
      level: 'error',
      message: `The parser rejected the manifest: ${parsed.error.code}${reason ? `, ${reason}` : ''}.`,
    });
  }
  if (parsed.kind === 'hls-master') {
    checks.push(...checkHlsMasterText(text));
    if (parsed.presentation !== null)
      checks.push(...(await checkPresentation(parsed.presentation)));
  } else if (parsed.kind === 'hls-media') {
    checks.push(...checkHlsMediaText(text, parsed.playlist));
  } else {
    checks.push(...checkDashText(text));
    if (parsed.presentation !== null)
      checks.push(...(await checkPresentation(parsed.presentation)));
  }
  const order: Record<CheckLevel, number> = { error: 0, warn: 1, info: 2, ok: 3 };
  return dedupe(checks).sort((a, b) => order[a.level] - order[b.level]);
}
