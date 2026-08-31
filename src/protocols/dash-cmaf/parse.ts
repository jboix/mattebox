/**
 * MPD into the IR. Pure: no fetching, no state, no side effects. DOMParser
 * carries the XML work at zero bundle cost. URLs are resolved here, against
 * the BaseURL chain, and stored absolute; downstream code never does URL
 * arithmetic.
 *
 * AdaptationSet and Representation already match the IR's Track and
 * Rendition, so unlike HLS there is no decomposition step. The coupling
 * table stays empty: any video representation composes with any audio
 * adaptation set. Preselection and @dependencyId would change that; both
 * are out of scope and noted in the register.
 *
 * Single-period only. Templated addressing stays lazy: SegmentTemplate
 * becomes IndexedSegments and the kernel materializes one segment at a
 * time, so a long window never becomes an array.
 */
import { findBox, parseSidx } from '../../containers/mp4-box/index.js';
import type { MatteboxError } from '../../types/error.js';
import type {
  ByteRange,
  ContentType,
  IndexedSegments,
  Presentation,
  ProtectionScheme,
  Rendition,
  Segment,
  SegmentRef,
  SegmentRun,
  SidxSegments,
  Track,
} from '../../types/ir.js';

export interface ParseResult {
  readonly presentation: Presentation | null;
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

/** ISO 8601 duration to seconds. Date parts use nominal day lengths. */
export function parseDuration(value: string | null): number | null {
  if (value === null) return null;
  const match =
    /^-?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value.trim(),
    );
  if (match === null) return null;
  const [, years, months, days, hours, minutes, seconds] = match;
  return (
    Number(years ?? 0) * 31_536_000 +
    Number(months ?? 0) * 2_592_000 +
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  );
}

/** Direct children by local name; namespace-agnostic on purpose. */
function children(parent: Element, name: string): readonly Element[] {
  const found: Element[] = [];
  for (const child of parent.children) {
    if (child.localName === name) found.push(child);
  }
  return found;
}

function attr(element: Element, name: string): string | null {
  return element.getAttribute(name);
}

function numberAttr(element: Element, name: string): number | null {
  const value = element.getAttribute(name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @frameRate is "30" or "30000/1001". */
function parseFrameRate(value: string | null): number | null {
  if (value === null) return null;
  const [num, den] = value.split('/').map(Number);
  if (num === undefined || !Number.isFinite(num)) return null;
  if (den !== undefined) return Number.isFinite(den) && den > 0 ? num / den : null;
  return num;
}

/** A DASH byte range is "start-end" inclusive (ISO/IEC 23009-1 §5.3.9.2.2). */
function parseByteRange(value: string | null): ByteRange | null {
  if (value === null) return null;
  const [startText, endText] = value.split('-');
  const start = Number(startText);
  const end = Number(endText);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/** The first BaseURL child resolved against `base`. Siblings are alternatives; the first wins. */
function applyBaseUrl(element: Element, base: string): string {
  const baseElements = children(element, 'BaseURL');
  const text = baseElements[0]?.textContent?.trim();
  return text !== undefined && text !== '' ? resolve(text, base) : base;
}

function base64ToArrayBuffer(text: string): ArrayBuffer | null {
  try {
    const binary = atob(text.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
}

const MP4_PROTECTION = 'urn:mpeg:dash:mp4protection:2011';
const UUID_URN = /^urn:uuid:([0-9a-f-]{36})$/i;

/**
 * ContentProtection elements into protection schemes. The mp4protection
 * element carries the common scheme and default key id; each urn:uuid
 * element names one key system, optionally with manifest init data.
 */
function parseProtection(elements: readonly Element[]): readonly ProtectionScheme[] {
  let commonScheme: string | null = null;
  let commonKeyId: string | null = null;
  for (const element of elements) {
    if (attr(element, 'schemeIdUri')?.toLowerCase() === MP4_PROTECTION) {
      commonScheme = attr(element, 'value')?.toLowerCase() ?? null;
      const kid = attr(element, 'cenc:default_KID') ?? attr(element, 'default_KID');
      commonKeyId = kid !== null ? kid.replaceAll('-', '').toLowerCase() : null;
    }
  }
  const schemes: ProtectionScheme[] = [];
  for (const element of elements) {
    const schemeIdUri = attr(element, 'schemeIdUri') ?? '';
    const uuid = UUID_URN.exec(schemeIdUri);
    if (uuid === null) continue;
    const pssh = children(element, 'pssh')[0]?.textContent?.trim();
    const initData = pssh !== undefined && pssh !== '' ? base64ToArrayBuffer(pssh) : null;
    schemes.push({
      systemId: (uuid[1] as string).toLowerCase(),
      scheme: commonScheme,
      keyId: commonKeyId,
      licenseUrl: null,
      initData,
      initDataType: initData !== null ? 'cenc' : null,
    });
  }
  if (schemes.length === 0 && (commonScheme !== null || commonKeyId !== null)) {
    schemes.push({
      systemId: null,
      scheme: commonScheme,
      keyId: commonKeyId,
      licenseUrl: null,
      initData: null,
      initDataType: null,
    });
  }
  return schemes;
}

interface TemplateInfo {
  readonly media: string | null;
  readonly initialization: string | null;
  readonly timescale: number;
  readonly startNumber: number;
  readonly duration: number | null;
  readonly presentationTimeOffset: number;
  readonly timelineElement: Element | null;
}

/**
 * A trick-mode AdaptationSet: the DASH-IF trickmode EssentialProperty, or a
 * representation declaring a playout rate other than 1. Both mark an
 * I-frame-only set meant for scrubbing, never for normal playback.
 */
function isTrickMode(adaptationSet: Element): boolean {
  for (const property of children(adaptationSet, 'EssentialProperty')) {
    if ((attr(property, 'schemeIdUri') ?? '').includes('trickmode')) return true;
  }
  if (numberAttr(adaptationSet, 'maxPlayoutRate') !== null) return true;
  for (const representation of children(adaptationSet, 'Representation')) {
    const rate = numberAttr(representation, 'maxPlayoutRate');
    if (rate !== null && rate !== 1) return true;
  }
  return false;
}

/** Merges SegmentTemplate attributes down Period, AdaptationSet, Representation. */
function mergeTemplates(levels: readonly Element[]): TemplateInfo | null {
  let media: string | null = null;
  let initialization: string | null = null;
  let timescale: number | null = null;
  let startNumber: number | null = null;
  let duration: number | null = null;
  let pto: number | null = null;
  let timelineElement: Element | null = null;
  let found = false;
  for (const level of levels) {
    const template = children(level, 'SegmentTemplate')[0];
    if (template === undefined) continue;
    found = true;
    media = attr(template, 'media') ?? media;
    initialization = attr(template, 'initialization') ?? initialization;
    timescale = numberAttr(template, 'timescale') ?? timescale;
    startNumber = numberAttr(template, 'startNumber') ?? startNumber;
    duration = numberAttr(template, 'duration') ?? duration;
    pto = numberAttr(template, 'presentationTimeOffset') ?? pto;
    timelineElement = children(template, 'SegmentTimeline')[0] ?? timelineElement;
  }
  if (!found) return null;
  return {
    media,
    initialization,
    timescale: timescale ?? 1,
    startNumber: startNumber ?? 1,
    duration,
    presentationTimeOffset: pto ?? 0,
    timelineElement,
  };
}

/**
 * SegmentTimeline into compressed runs. @r repeats; a negative @r repeats
 * until the next S@t, or the period end on the last S.
 */
function parseTimeline(
  timelineElement: Element,
  periodEndUnits: number | null,
): readonly SegmentRun[] | null {
  const sElements = children(timelineElement, 'S');
  const runs: SegmentRun[] = [];
  let time = 0;
  for (let i = 0; i < sElements.length; i += 1) {
    const s = sElements[i] as Element;
    const d = numberAttr(s, 'd');
    if (d === null || d <= 0) return null;
    time = numberAttr(s, 't') ?? time;
    const r = numberAttr(s, 'r') ?? 0;
    let count: number;
    if (r >= 0) {
      count = r + 1;
    } else {
      const next = sElements[i + 1];
      const until = next !== undefined ? numberAttr(next, 't') : periodEndUnits;
      if (until === null || until === undefined) return null;
      count = Math.max(1, Math.ceil((until - time) / d));
    }
    runs.push({ start: time, duration: d, count });
    time += d * count;
  }
  return runs.length > 0 ? runs : null;
}

/** Constant substitutions: $RepresentationID$ and $Bandwidth$, with format tags, and never $$-escaped content. */
function substituteIdentity(template: string, id: string, bandwidth: number): string {
  return template
    .replace(/\$RepresentationID\$/g, id)
    .replace(/\$Bandwidth(?:%0(\d+)d)?\$/g, (_, width?: string) => {
      const text = String(bandwidth);
      return width === undefined ? text : text.padStart(Number(width), '0');
    });
}

function contentTypeOf(adaptationSet: Element, mimeType: string): ContentType {
  const declared = attr(adaptationSet, 'contentType');
  if (
    declared === 'video' ||
    declared === 'audio' ||
    declared === 'text' ||
    declared === 'image' ||
    declared === 'metadata'
  ) {
    return declared;
  }
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('text/') || mimeType === 'application/ttml+xml') return 'text';
  return 'video';
}

/** parse an MPD document into a Presentation. Never throws. */
export function parse(text: string, baseUrl: string): ParseResult {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, 'text/xml');
  } catch (cause) {
    return { presentation: null, error: { ...manifestError('unparsable XML'), cause } };
  }
  const mpd = doc.documentElement;
  if (
    mpd === null ||
    mpd.localName !== 'MPD' ||
    doc.getElementsByTagName('parsererror').length > 0
  ) {
    return { presentation: null, error: manifestError('not an MPD document') };
  }

  const isLive = attr(mpd, 'type') === 'dynamic';
  const mpdDuration = parseDuration(attr(mpd, 'mediaPresentationDuration'));
  const mpdBase = applyBaseUrl(mpd, baseUrl);

  // Live delivery metadata, normalized for the dash-live stage. The parser
  // only records; wall-clock arithmetic happens in the stage, from facts.
  let live: import('../../types/ir.js').LiveInfo | undefined;
  if (isLive) {
    const availabilityStart = Date.parse(attr(mpd, 'availabilityStartTime') ?? '');
    const updatePeriod = parseDuration(attr(mpd, 'minimumUpdatePeriod'));
    const timeShiftDepth = parseDuration(attr(mpd, 'timeShiftBufferDepth'));
    const holdBack = parseDuration(attr(mpd, 'suggestedPresentationDelay'));
    const timing = children(mpd, 'UTCTiming')[0];
    live = {
      ...(Number.isFinite(availabilityStart)
        ? { availabilityStart: availabilityStart / 1000 }
        : {}),
      ...(updatePeriod !== null ? { updatePeriod } : {}),
      ...(timeShiftDepth !== null ? { timeShiftDepth } : {}),
      ...(holdBack !== null ? { holdBack } : {}),
      ...(timing !== undefined
        ? {
            timeServer: {
              scheme: attr(timing, 'schemeIdUri') ?? '',
              value: attr(timing, 'value') ?? '',
            },
          }
        : {}),
    };
  }

  // ContentSteering plus BaseURL@serviceLocation alternatives: the bases
  // map is the DASH pathway table the steering stage switches between.
  let steering: import('../../types/ir.js').SteeringInfo | undefined;
  const steeringElement = children(mpd, 'ContentSteering')[0];
  if (steeringElement !== undefined) {
    const serverUri = steeringElement.textContent?.trim() ?? '';
    if (serverUri !== '') {
      const bases: Record<string, string> = {};
      for (const base of children(mpd, 'BaseURL')) {
        const location = attr(base, 'serviceLocation');
        const text = base.textContent?.trim();
        if (location !== null && text !== undefined && text !== '') {
          bases[location] = resolve(text, baseUrl);
        }
      }
      steering = {
        serverUri: resolve(serverUri, baseUrl),
        ...(attr(steeringElement, 'defaultServiceLocation') !== null
          ? { defaultPathway: attr(steeringElement, 'defaultServiceLocation') as string }
          : {}),
        ...(Object.keys(bases).length > 0 ? { bases } : {}),
      };
    }
  }

  const periodElements = children(mpd, 'Period');
  const periodElement = periodElements[0];
  if (periodElement === undefined) {
    return {
      presentation: null,
      error: {
        category: 'manifest',
        code: 'MANIFEST_EMPTY',
        fatal: true,
        recoverable: false,
        context: { reason: 'MPD with no Period' },
      },
    };
  }

  const periodStart = parseDuration(attr(periodElement, 'start')) ?? 0;
  const periodDuration =
    parseDuration(attr(periodElement, 'duration')) ??
    (mpdDuration !== null ? mpdDuration - periodStart : null);
  const periodBase = applyBaseUrl(periodElement, mpdBase);

  const tracks: Track[] = [];
  const adaptationSets = children(periodElement, 'AdaptationSet');
  for (let asIndex = 0; asIndex < adaptationSets.length; asIndex += 1) {
    const adaptationSet = adaptationSets[asIndex] as Element;
    // DASH-IF IOP: an AdaptationSet carrying an EssentialProperty the client
    // does not understand must be ignored. The only one seen in the wild
    // here is trick mode, an I-frame-only set for scrubbing whose segments
    // hold one frame each; chosen as the video track it never fills a
    // buffer and the scheduling breaker halts playback.
    if (isTrickMode(adaptationSet)) continue;
    const asBase = applyBaseUrl(adaptationSet, periodBase);
    const asMime = attr(adaptationSet, 'mimeType');
    const asCodecs = attr(adaptationSet, 'codecs');
    const lang = attr(adaptationSet, 'lang');
    const role = children(adaptationSet, 'Role')[0]?.getAttribute('value') ?? null;
    const protectionSchemes = parseProtection(children(adaptationSet, 'ContentProtection'));

    const renditions: Rendition[] = [];
    let trackMime: string | null = null;
    for (const representation of children(adaptationSet, 'Representation')) {
      const id = attr(representation, 'id');
      const bandwidth = numberAttr(representation, 'bandwidth');
      if (id === null || bandwidth === null) continue;
      const repBase = applyBaseUrl(representation, asBase);
      const mimeType = attr(representation, 'mimeType') ?? asMime ?? 'video/mp4';
      trackMime = trackMime ?? mimeType;

      // On-demand profile: a single file whose segments are described by a
      // sidx box at @indexRange. The concrete segments are unknown until that
      // box is fetched, so emit sidx addressing for the dash slice to resolve;
      // the child Initialization@range is the init segment inside the file.
      const segmentBase = children(representation, 'SegmentBase')[0];
      if (segmentBase !== undefined) {
        const indexRange = parseByteRange(attr(segmentBase, 'indexRange'));
        if (indexRange === null) continue;
        const baseTimescale = numberAttr(segmentBase, 'timescale') ?? 1;
        const pto = numberAttr(segmentBase, 'presentationTimeOffset');
        const initElement = children(segmentBase, 'Initialization')[0];
        const initRange =
          initElement !== undefined ? parseByteRange(attr(initElement, 'range')) : null;
        const sidxSegments: SidxSegments = {
          kind: 'sidx',
          url: repBase,
          indexRange,
          timescale: baseTimescale,
          ...(pto !== null && pto !== 0 ? { presentationTimeOffset: pto / baseTimescale } : {}),
        };
        const sidxInit: SegmentRef | null =
          initRange !== null ? { url: repBase, byteRange: initRange } : null;
        const w = numberAttr(representation, 'width');
        const h = numberAttr(representation, 'height');
        const fr =
          parseFrameRate(attr(representation, 'frameRate')) ??
          parseFrameRate(attr(adaptationSet, 'frameRate'));
        renditions.push({
          id,
          bitrate: bandwidth,
          codecs: attr(representation, 'codecs') ?? asCodecs,
          mimeType,
          segments: sidxSegments,
          ...(sidxInit !== null ? { init: sidxInit } : {}),
          ...(w !== null ? { width: w } : {}),
          ...(h !== null ? { height: h } : {}),
          ...(fr !== null ? { frameRate: fr } : {}),
        });
        continue;
      }

      const template = mergeTemplates([periodElement, adaptationSet, representation]);
      if (template === null || template.media === null) {
        // No addressing and no index: the representation is one whole file
        // at its BaseURL. For text that is the everyday case, a single
        // WebVTT file for the period, so it becomes one segment spanning
        // the period. Media without a sidx cannot be scheduled; skipped.
        if (contentTypeOf(adaptationSet, mimeType) === 'text' && periodDuration !== null) {
          renditions.push({
            id,
            bitrate: bandwidth,
            codecs: attr(representation, 'codecs') ?? asCodecs,
            mimeType,
            segments: [{ seq: 0, start: periodStart, duration: periodDuration, url: repBase }],
          });
        }
        continue;
      }

      const periodEndUnits =
        periodDuration !== null
          ? Math.round(template.presentationTimeOffset + periodDuration * template.timescale)
          : null;
      const timeline =
        template.timelineElement !== null
          ? parseTimeline(template.timelineElement, periodEndUnits)
          : null;
      if (template.timelineElement !== null && timeline === null) {
        return { presentation: null, error: manifestError(`bad SegmentTimeline in '${id}'`) };
      }

      let endSeq: number | null = null;
      if (timeline !== null) {
        endSeq = template.startNumber - 1 + timeline.reduce((sum, run) => sum + run.count, 0);
      } else if (template.duration !== null && periodDuration !== null) {
        endSeq =
          template.startNumber -
          1 +
          Math.ceil((periodDuration * template.timescale) / template.duration);
      } else if (template.duration === null) {
        return { presentation: null, error: manifestError(`no addressing for '${id}'`) };
      }

      const segments: IndexedSegments = {
        kind: 'indexed',
        urlTemplate: resolve(substituteIdentity(template.media, id, bandwidth), repBase),
        startSeq: template.startNumber,
        endSeq: isLive ? null : endSeq,
        timescale: template.timescale,
        segmentDuration: timeline !== null ? null : template.duration,
        timeline,
        ...(template.presentationTimeOffset !== 0
          ? { presentationTimeOffset: template.presentationTimeOffset }
          : {}),
      };

      const init: SegmentRef | null =
        template.initialization !== null
          ? { url: resolve(substituteIdentity(template.initialization, id, bandwidth), repBase) }
          : null;

      const frameRate =
        parseFrameRate(attr(representation, 'frameRate')) ??
        parseFrameRate(attr(adaptationSet, 'frameRate'));
      const width = numberAttr(representation, 'width');
      const height = numberAttr(representation, 'height');
      renditions.push({
        id,
        bitrate: bandwidth,
        codecs: attr(representation, 'codecs') ?? asCodecs,
        mimeType,
        segments,
        ...(init !== null ? { init } : {}),
        ...(width !== null ? { width } : {}),
        ...(height !== null ? { height } : {}),
        ...(frameRate !== null ? { frameRate } : {}),
      });
    }

    if (renditions.length === 0) continue;
    const mimeType = trackMime ?? 'video/mp4';
    tracks.push({
      id: attr(adaptationSet, 'id') !== null ? `as-${attr(adaptationSet, 'id')}` : `as-i${asIndex}`,
      contentType: contentTypeOf(adaptationSet, mimeType),
      mimeType,
      protection: protectionSchemes.length > 0 ? { schemes: protectionSchemes } : null,
      renditions,
      ...(lang !== null ? { lang } : {}),
      ...(role !== null ? { role } : {}),
    });
  }

  if (tracks.length === 0) {
    return {
      presentation: null,
      error: {
        category: 'manifest',
        code: 'MANIFEST_EMPTY',
        fatal: true,
        recoverable: false,
        context: { reason: 'no playable adaptation set' },
      },
    };
  }

  return {
    presentation: {
      id: baseUrl,
      isLive,
      ...(mpdDuration !== null ? { duration: mpdDuration } : {}),
      periods: [
        {
          id: attr(periodElement, 'id') ?? 'p0',
          start: periodStart,
          ...(periodDuration !== null ? { duration: periodDuration } : {}),
          tracks,
        },
      ],
      couplings: [],
      ...(live !== undefined ? { live } : {}),
      ...(steering !== undefined ? { steering } : {}),
    },
    error: null,
  };
}

/**
 * Turns a fetched sidx box into explicit byte-range segments. The first media
 * byte sits immediately after the sidx box (indexRange.end + 1) plus the box's
 * own firstOffset; each reference then names one subsegment's byte size and
 * duration in timescale units. ISO/IEC 14496-12 SegmentIndexBox.
 */
export function sidxToSegments(sidxBytes: Uint8Array, addressing: SidxSegments): Segment[] {
  // The fetched bytes are the whole sidx box; parseSidx wants its payload.
  const box = findBox(sidxBytes, 'sidx');
  if (box === null) return [];
  const sidx = parseSidx(box.payload);
  if (sidx === null) return [];
  const timescale = sidx.timescale || addressing.timescale || 1;
  const pto = addressing.presentationTimeOffset ?? 0;
  let offset = addressing.indexRange.end + 1 + sidx.firstOffset;
  let mediaTime = sidx.earliestPresentationTime;
  const segments: Segment[] = [];
  for (let i = 0; i < sidx.references.length; i += 1) {
    const ref = sidx.references[i];
    if (ref === undefined) break;
    segments.push({
      seq: i,
      start: mediaTime / timescale - pto,
      duration: ref.subsegmentDuration / timescale,
      url: addressing.url,
      byteRange: { start: offset, end: offset + ref.referencedSize - 1 },
    });
    offset += ref.referencedSize;
    mediaTime += ref.subsegmentDuration;
  }
  return segments;
}

/**
 * Immutably swaps a rendition's unresolved sidx addressing for the explicit
 * segment list parsed from its index box. Everything else about the
 * presentation is already known from the MPD.
 */
export function mergeSidx(
  presentation: Presentation,
  renditionId: string,
  segments: readonly Segment[],
): Presentation {
  return {
    ...presentation,
    periods: presentation.periods.map((period) => ({
      ...period,
      tracks: period.tracks.map((track) =>
        track.renditions.some((r) => r.id === renditionId)
          ? {
              ...track,
              renditions: track.renditions.map((rendition) =>
                rendition.id === renditionId ? { ...rendition, segments } : rendition,
              ),
            }
          : track,
      ),
    })),
  };
}
