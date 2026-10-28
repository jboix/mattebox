/**
 * Breaks from what the stream signals, as plain data. HLS interstitials
 * (draft-pantos-hls-rfc8216bis Appendix D), DASH alternative MPD events
 * (ISO/IEC 23009-1 6th edition), and SCTE-35 cue-outs in either protocol
 * become one descriptor, so one schedule plays them all. Nothing here
 * touches the element or the network.
 */
import { scte35Summary } from '../../containers/scte35.js';
import { resolveUrl } from '../../kernel/url.js';
import type { DateRange, EventElement, Presentation, PresentationEvent } from '../../types/ir.js';
import type { Scte35Summary } from '../../types/metadata.js';

/** A beacon the stream names for an asset: a DASH callback event, at an offset in the asset. */
export interface BreakTracking {
  /** Seconds from the asset's start. */
  readonly offset: number;
  readonly url: string;
}

/**
 * An ad creative the stream describes, SVTA2053 Ad Creative Signaling
 * (payload version 2): its identifiers and the beacons a player sends while
 * it plays, by their VAST names.
 */
export interface AdCreative {
  /** Seconds. */
  readonly duration?: number;
  readonly identifiers: readonly { readonly scheme: string; readonly value: string }[];
  readonly tracking: readonly { readonly event: string; readonly url: string }[];
  /** Seconds after which the viewer may skip it. */
  readonly skipOffset?: number;
  readonly clickThrough?: string;
}

/** One clip of a break, by its manifest URL. */
export interface BreakAsset {
  readonly url: string;
  /** Seconds, when the stream or the asset list says. */
  readonly duration?: number;
  readonly mimeType?: string;
  readonly tracking?: readonly BreakTracking[];
  /** What SVTA2053 says of the ads in the asset. */
  readonly creatives?: readonly AdCreative[];
}

/** A span of the presentation where something else plays, from any source. */
export interface Break {
  readonly id: string;
  readonly source: 'hls' | 'dash' | 'scte35' | 'page';
  /** Presentation time of the start, in seconds. */
  readonly start: number;
  /** Before the first frame, or after the end. */
  readonly cue?: 'pre' | 'post';
  /** Plays once: a seek back does not play it again. */
  readonly once: boolean;
  readonly assets: readonly BreakAsset[];
  /** A URL that lists the assets when asked: an HLS asset list, or a DASH alternative MPD. */
  readonly assetList?: string;
  /** Seconds of the presentation the break takes the place of. 0 inserts. */
  readonly covers: number;
  /** Seconds after the start where the presentation resumes. */
  readonly resumeOffset: number;
  /** The longest the break plays, in seconds. */
  readonly playoutLimit?: number;
  /** No seek inside the break. */
  readonly noSkip: boolean;
  /** No seek past the break without playing it. */
  readonly noJump: boolean;
  /** Seconds into an asset after which `skip()` works, also in a break that takes no seek. */
  readonly skipAfter?: number;
  /** Seconds before the start from which the asset list may be fetched. */
  readonly resolveAhead?: number;
  /** HLS `X-SNAP`: start at the segment boundary before the start, return at the one after the resume point. */
  readonly snap?: { readonly out: boolean; readonly in: boolean };
  /** For a cue-out: what its SCTE-35 section says. */
  readonly scte35?: Scte35Summary;
  /** The ads SVTA2053 describes in a span the stream plays itself, or in the assets. */
  readonly creatives?: readonly AdCreative[];
  /**
   * What the span is, from its SCTE-35 segmentation type: an ad (the
   * default), a promotion, or a span that is no break at all, the opening
   * or closing credits or a chapter, which a player shows as such.
   */
  readonly role?: SpanRole;
  /** The attributes as the stream wrote them. */
  readonly attributes: Readonly<Record<string, string>>;
}

const INTERSTITIAL = 'com.apple.hls.interstitial';
const ALT_INSERT = 'urn:mpeg:dash:event:alternativeMPD:insert:2025';
const ALT_REPLACE = 'urn:mpeg:dash:event:alternativeMPD:replace:2025';
/** SCTE 214-1 §6.6 and §6.7: a splice in binary (base64) or in XML. */
const SCTE35_SCHEMES = new Set(['urn:scte:scte35:2013:bin', 'urn:scte:scte35:2014:xml+bin']);
/** What a span the stream signals is. */
export type SpanRole = 'ad' | 'promo' | 'opening-credits' | 'closing-credits' | 'chapter';

/**
 * The role of each segmentation_type_id that starts a span, by ANSI/SCTE 35's
 * table of them: a break, an ad, a placement opportunity, an ad block, a
 * promotion, the credits, a chapter. The end ids, the programme's
 * boundaries, overlays, unscheduled events and the network's start and end
 * start no span the viewer sees.
 */
const ROLES: ReadonlyMap<number, SpanRole> = new Map([
  [0x20, 'chapter'],
  [0x22, 'ad'],
  [0x24, 'opening-credits'],
  [0x26, 'closing-credits'],
  [0x30, 'ad'],
  [0x32, 'ad'],
  [0x34, 'ad'],
  [0x36, 'ad'],
  [0x3c, 'promo'],
  [0x3e, 'promo'],
  [0x44, 'ad'],
  [0x46, 'ad'],
]);

/**
 * The role and the length a SCTE-35 section gives a span: the first of its
 * segmentation descriptors with a role, the outermost, as SCTE 35 nests
 * them. A section without descriptors, a splice_insert, is an ad break. Null
 * for a section whose descriptors start no span the viewer sees.
 */
function roleOf(summary: Scte35Summary | null): { role: SpanRole; duration?: number } | null {
  if (summary === null || summary.segmentations.length === 0) return { role: 'ad' };
  for (const segmentation of summary.segmentations) {
    if (segmentation.cancel || segmentation.typeId === undefined) continue;
    const role = ROLES.get(segmentation.typeId);
    if (role !== undefined) {
      return segmentation.duration === undefined
        ? { role }
        : { role, duration: segmentation.duration };
    }
  }
  return null;
}

/** SVTA2053-1: the creatives of a span, as JSON in a DASH Event. */
const AD_CREATIVES = 'urn:svta:advertising-wg:ad-creative-signaling';

/**
 * The creatives of an SVTA2053 payload, version 2: JSON with a `payload`
 * list of creatives, each with `identifiers`, `tracking` (a `type` and
 * its `urls`), `duration`, `skipOffset` and `clickThrough`. HLS carries it
 * in `X-AD-CREATIVE-SIGNALING`, base64 or as written. Nothing for a
 * payload that does not read.
 */
export function creativesOf(text: string | undefined): AdCreative[] {
  if (text === undefined || text === '') return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    try {
      value = JSON.parse(atob(text.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      return [];
    }
  }
  const list = (value as { payload?: unknown } | null)?.payload;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: Record<string, unknown>) => {
    if (item === null || typeof item !== 'object') return [];
    const tracking = (Array.isArray(item.tracking) ? item.tracking : []).flatMap(
      (entry: { type?: unknown; urls?: unknown }) =>
        typeof entry?.type === 'string' && Array.isArray(entry.urls)
          ? entry.urls
              .filter((url): url is string => typeof url === 'string')
              .map((url) => ({ event: entry.type as string, url }))
          : [],
    );
    const identifiers = (Array.isArray(item.identifiers) ? item.identifiers : []).filter(
      (id: { scheme?: unknown; value?: unknown }) =>
        typeof id?.scheme === 'string' && typeof id.value === 'string',
    );
    return [
      {
        ...(typeof item.duration === 'number' ? { duration: item.duration } : {}),
        identifiers,
        tracking,
        ...(typeof item.skipOffset === 'number' ? { skipOffset: item.skipOffset } : {}),
        ...(typeof item.clickThrough === 'string' ? { clickThrough: item.clickThrough } : {}),
      },
    ];
  });
}

/** Seconds from a number or an xs:duration such as `PT5S`; undefined otherwise. */
export function seconds(text: string | undefined): number | undefined {
  if (text === undefined || text === '') return undefined;
  const plain = Number(text);
  if (Number.isFinite(plain)) return plain;
  const match = /^PT(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(text);
  if (match === null) return undefined;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function hexBytes(value: string | undefined): Uint8Array | undefined {
  if (value === undefined || !/^0x([0-9a-f]{2})+$/i.test(value)) return undefined;
  const out = new Uint8Array((value.length - 2) / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = Number.parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

function base64Bytes(text: string | undefined): Uint8Array | undefined {
  if (text === undefined) return undefined;
  try {
    const binary = atob(text.replace(/\s+/g, ''));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** An HLS interstitial date range, or a cue-out date range, as a break. */
function fromDateRange(range: DateRange, base: string, duration: number | undefined): Break | null {
  const a = range.attributes;
  const span = range.end !== undefined ? range.end - range.start : undefined;
  if (
    a.CLASS === INTERSTITIAL &&
    (a['X-ASSET-URI'] !== undefined || a['X-ASSET-LIST'] !== undefined)
  ) {
    const cues = (a.CUE ?? '').split(',');
    const cue = cues.includes('PRE') ? 'pre' : cues.includes('POST') ? 'post' : undefined;
    const restrict = (a['X-RESTRICT'] ?? '').split(',');
    const covers = a['X-TIMELINE-OCCUPIES'] === 'RANGE' ? (span ?? 0) : 0;
    const limit = seconds(a['X-PLAYOUT-LIMIT']);
    const skipAfter = seconds(a['X-SKIP-CONTROL-OFFSET']);
    const snap = (a['X-SNAP'] ?? '').split(',');
    return {
      id: range.id,
      source: 'hls',
      start: cue === 'pre' ? 0 : cue === 'post' ? (duration ?? range.start) : range.start,
      ...(cue !== undefined ? { cue } : {}),
      once: cues.includes('ONCE'),
      assets: a['X-ASSET-URI'] !== undefined ? [{ url: resolveUrl(a['X-ASSET-URI'], base) }] : [],
      ...(a['X-ASSET-LIST'] !== undefined
        ? { assetList: resolveUrl(a['X-ASSET-LIST'], base) }
        : {}),
      covers,
      // Appendix D: without X-RESUME-OFFSET, the primary resumes after the
      // date range's duration, as hls.js reads it; a pre- or post-roll at 0.
      resumeOffset: seconds(a['X-RESUME-OFFSET']) ?? (cue === undefined ? (span ?? 0) : 0),
      ...(limit !== undefined ? { playoutLimit: limit } : {}),
      noSkip: restrict.includes('SKIP'),
      noJump: restrict.includes('JUMP'),
      ...(skipAfter !== undefined ? { skipAfter } : {}),
      ...(snap.includes('OUT') || snap.includes('IN')
        ? { snap: { out: snap.includes('OUT'), in: snap.includes('IN') } }
        : {}),
      ...withCreatives(creativesOf(a['X-AD-CREATIVE-SIGNALING'])),
      attributes: a,
    };
  }
  const creatives = creativesOf(a['X-AD-CREATIVE-SIGNALING']);
  const section = hexBytes(a['SCTE35-OUT']);
  if (section === undefined && a['CUE-OUT'] === undefined) {
    // A date range that only describes the ads in it: the stream plays them.
    const found = opportunity(range.id, range.start, span ?? 0, null, a);
    return creatives.length === 0 || found === null ? null : { ...found, source: 'hls', creatives };
  }
  const summary = section === undefined ? null : scte35Summary(section);
  const planned = range.plannedEnd !== undefined ? range.plannedEnd - range.start : undefined;
  const found = opportunity(range.id, range.start, span ?? planned ?? 0, summary, a);
  return found === null ? null : { ...found, ...withCreatives(creatives) };
}

const withCreatives = (creatives: readonly AdCreative[]): { creatives?: readonly AdCreative[] } =>
  creatives.length > 0 ? { creatives } : {};

/**
 * A span the stream plays itself, from a cue-out or a SCTE-35 section: its
 * length is the stream's, else the section's. Null for a section that
 * starts no span the viewer sees.
 */
function opportunity(
  id: string,
  start: number,
  length: number,
  summary: Scte35Summary | null,
  attributes: Readonly<Record<string, string>>,
): Break | null {
  const role = roleOf(summary);
  if (role === null) return null;
  const covers = length > 0 ? length : (role.duration ?? summary?.breakDuration ?? 0);
  return {
    id,
    source: 'scte35',
    start,
    once: false,
    assets: [],
    covers,
    resumeOffset: covers,
    noSkip: false,
    noJump: false,
    ...(summary !== null ? { scte35: summary } : {}),
    ...(role.role !== 'ad' ? { role: role.role } : {}),
    attributes,
  };
}

/**
 * Annex I of ISO/IEC 23009-1: a `RequestParam` with `useMPDUrlQuery`
 * whose template holds `$querypart$` carries the MPD URL's query to the
 * requests it names. livesim2 sends a viewer's `sessionId` and `interests`
 * to its ad server this way.
 */
function withQuery(
  url: string,
  params: readonly EventElement[],
  kind: string,
  mpd: string,
): string {
  const param = params.find(
    (p) =>
      p.name === 'RequestParam' &&
      p.attributes.useMPDUrlQuery === 'true' &&
      (p.attributes.queryTemplate ?? '').includes('$querypart$') &&
      (p.attributes.includeInRequests ?? '').split(' ').includes(kind),
  );
  const query = mpd.includes('?') ? mpd.slice(mpd.indexOf('?') + 1) : '';
  if (param === undefined || query === '') return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

/** A DASH alternative MPD event, or an SCTE-35 event, as a break. */
export function fromEvent(event: PresentationEvent, mpd: string): Break | null {
  if (event.scheme === ALT_INSERT || event.scheme === ALT_REPLACE) {
    const element = event.elements?.find(
      (e) => e.name === 'InsertPresentation' || e.name === 'ReplacePresentation',
    );
    const uri = element?.attributes.uri ?? element?.attributes.url;
    if (element === undefined || uri === undefined) return null;
    const a = element.attributes;
    const scale = event.timescale ?? 1;
    const ticks = (name: string): number | undefined => {
      const value = Number(a[name]);
      return Number.isFinite(value) && a[name] !== undefined ? value / scale : undefined;
    };
    const replace = event.scheme === ALT_REPLACE;
    const length = event.duration ?? 0;
    const limit = ticks('maxDuration');
    const ahead = ticks('earliestResolutionTimeOffset');
    const skipAfter = seconds(a.skipAfter);
    const resume = ticks('returnOffset') ?? (replace ? length : 0);
    return {
      id: event.id,
      source: 'dash',
      start: event.start,
      once: a.executeOnce === 'true',
      assets: [],
      assetList: withQuery(resolveUrl(uri, mpd), event.streamElements ?? [], 'altmpd', mpd),
      covers: replace ? length : 0,
      resumeOffset: resume,
      ...(limit !== undefined ? { playoutLimit: limit } : {}),
      noSkip: false,
      noJump: a.noJump !== undefined && a.noJump !== '0',
      ...(skipAfter !== undefined ? { skipAfter } : {}),
      ...(ahead !== undefined ? { resolveAhead: ahead } : {}),
      attributes: a,
    };
  }
  if (event.scheme === AD_CREATIVES) {
    const creatives = creativesOf(event.data);
    const length = event.duration ?? creatives[0]?.duration ?? 0;
    const found = opportunity(`${event.scheme}|${event.id}`, event.start, length, null, {});
    if (creatives.length === 0 || length <= 0 || found === null) return null;
    // The ads are in the stream: a span the presentation plays itself.
    return { ...found, source: 'dash', creatives };
  }
  if (!SCTE35_SCHEMES.has(event.scheme)) return null;
  const section = base64Bytes(event.data);
  const summary = section === undefined ? null : scte35Summary(section);
  const found = opportunity(
    `${event.scheme}|${event.id}`,
    event.start,
    event.duration ?? 0,
    summary,
    {},
  );
  if (found === null || (found.covers <= 0 && summary?.outOfNetwork !== true)) return null;
  return found;
}

/**
 * Every break the presentation signals now, by start. Date ranges merge
 * by ID across renditions, as RFC 8216bis §4.4.5.1 merges later tags:
 * attributes add, none changes. Relative URIs resolve against the media
 * playlist that carried them, or the MPD.
 */
export function breaksOf(presentation: Presentation, url: string): Break[] {
  const ranges = new Map<string, { range: DateRange; base: string }>();
  const out: Break[] = [];
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        for (const range of rendition.dateRanges ?? []) {
          const known = ranges.get(range.id);
          ranges.set(range.id, {
            range:
              known === undefined
                ? range
                : {
                    ...known.range,
                    ...(known.range.end === undefined && range.end !== undefined
                      ? { end: range.end }
                      : {}),
                    attributes: { ...range.attributes, ...known.range.attributes },
                  },
            base: known?.base ?? rendition.playlistUrl ?? url,
          });
        }
      }
    }
    for (const event of period.events ?? []) {
      const entry = fromEvent(event, url);
      if (entry !== null) out.push(entry);
    }
  }
  for (const { range, base } of ranges.values()) {
    const entry = fromDateRange(range, base, presentation.duration);
    if (entry !== null) out.push(entry);
  }
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/**
 * The assets an asset list names. An HLS asset list is JSON with an
 * `ASSETS` array of `URI` and `DURATION` (Appendix D). A DASH List MPD
 * imports each asset as an `ImportedMPD` in a Period, with its callback
 * events as beacons (ISO/IEC 23009-1 6th edition). Any other MPD is the
 * asset itself.
 */
export function assetsOf(text: string, url: string): BreakAsset[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    const list = JSON.parse(trimmed) as { ASSETS?: { URI?: string; DURATION?: number }[] };
    return (list.ASSETS ?? []).flatMap((asset) =>
      asset.URI === undefined
        ? []
        : [
            {
              url: resolveUrl(asset.URI, url),
              ...(typeof asset.DURATION === 'number' ? { duration: asset.DURATION } : {}),
            },
          ],
    );
  }
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const mpd = doc.documentElement;
  if (mpd === null || mpd.localName !== 'MPD' || mpd.getAttribute('type') !== 'list') {
    return [{ url, mimeType: 'application/dash+xml' }];
  }
  const assets: BreakAsset[] = [];
  for (const period of Array.from(mpd.children).filter((e) => e.localName === 'Period')) {
    const imported = Array.from(period.children).find((e) => e.localName === 'ImportedMPD');
    const href = imported?.getAttribute('uri') ?? imported?.textContent?.trim();
    if (href === undefined || href === '') continue;
    const tracking: BreakTracking[] = [];
    for (const stream of Array.from(period.children).filter((e) => e.localName === 'EventStream')) {
      if (stream.getAttribute('schemeIdUri') !== 'urn:mpeg:dash:event:callback:2015') continue;
      const scale = Number(stream.getAttribute('timescale') ?? 1) || 1;
      const params: EventElement[] = Array.from(stream.children)
        .filter((e) => e.localName === 'RequestParam')
        .map((e) => ({
          name: 'RequestParam',
          attributes: Object.fromEntries(Array.from(e.attributes, (x) => [x.localName, x.value])),
        }));
      for (const event of Array.from(stream.children).filter((e) => e.localName === 'Event')) {
        const target = event.textContent?.trim();
        if (target === undefined || target === '') continue;
        tracking.push({
          offset: Number(event.getAttribute('presentationTime') ?? 0) / scale,
          url: withQuery(resolveUrl(target, url), params, 'callback', url),
        });
      }
    }
    const duration = seconds(period.getAttribute('duration') ?? undefined);
    const creatives = Array.from(period.children)
      .filter(
        (e) => e.localName === 'EventStream' && e.getAttribute('schemeIdUri') === AD_CREATIVES,
      )
      .flatMap((stream) => Array.from(stream.children).filter((e) => e.localName === 'Event'))
      .flatMap((event) => creativesOf(event.textContent?.trim()));
    assets.push({
      url: resolveUrl(href, url),
      mimeType: 'application/dash+xml',
      ...(duration !== undefined ? { duration } : {}),
      ...(tracking.length > 0 ? { tracking } : {}),
      ...withCreatives(creatives),
    });
  }
  return assets;
}
