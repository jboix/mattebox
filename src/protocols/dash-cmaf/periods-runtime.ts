/**
 * What a flattened multi-period presentation needs at playback time, kept
 * in the dash-cmaf stage so the kernel stays unaware of periods:
 *
 * - A segment whose period has another init than its rendition's gets that
 *   init in front of it before the append. MSE takes an init and a media
 *   segment in one append, and the time probe reads the timescale from the
 *   same bytes. The kernel only ever appends the rendition's own init, which
 *   this transform sees go by, so it knows which init each buffer holds.
 * - A WebVTT document whose cues count from its period's start gets an
 *   `X-TIMESTAMP-MAP` header with that start, which text-webvtt-segmented
 *   applies, as for HLS.
 * - A period left out for its codec family is seeked past when playback
 *   reaches it.
 *
 * Single-period content takes none of these paths.
 */
import { findRendition } from '../../kernel/presentation.js';
import { segmentAt } from '../../kernel/timeline.js';
import type { Presentation, SegmentRef } from '../../types/ir.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { StageContext } from '../../types/stage.js';

/** Before ts-transmux and caption extraction; decrypt-class steps run first. */
const PERIODS_ORDER = 10;
const MPEGTS_CLOCK = 90_000;

const keyOf = (ref: SegmentRef): string =>
  `${ref.url}|${ref.byteRange?.start ?? ''}-${ref.byteRange?.end ?? ''}`;

/** Whether any segment of the presentation carries its own init. */
function hasPeriodInits(presentation: Presentation): boolean {
  return presentation.periods.some((period) =>
    period.tracks.some((track) =>
      track.renditions.some(
        (rendition) =>
          Array.isArray(rendition.segments) &&
          rendition.segments.some((segment) => segment.init !== undefined),
      ),
    ),
  );
}

export function installPeriods(
  ctx: StageContext,
  skips: () => readonly { readonly start: number; readonly end: number }[],
): () => void {
  const element = ctx.element;
  /** By buffer (content type): the init it last received. Null after a seek: unknown. */
  const holds = new Map<string, string | null>();
  const inits = new Map<string, Promise<Uint8Array>>();
  let seen: Presentation | null = null;
  let periodInits = false;

  function initBytes(ref: SegmentRef): Promise<Uint8Array> {
    const key = keyOf(ref);
    let bytes = inits.get(key);
    if (bytes === undefined) {
      const headers: Record<string, string> =
        ref.byteRange === undefined
          ? {}
          : { Range: `bytes=${ref.byteRange.start}-${ref.byteRange.end}` };
      bytes = ctx.request(ref.url, { headers }).then(async (response) => {
        if (!response.ok) throw new Error(`period init ${ref.url}: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      });
      // A failed fetch is not kept: the next segment asks again.
      bytes.catch(() => inits.delete(key));
      inits.set(key, bytes);
    }
    return bytes;
  }

  async function transform(data: Uint8Array, meta: SegmentMeta): Promise<Uint8Array> {
    const presentation = ctx.getState().presentation;
    if (presentation !== seen) {
      seen = presentation;
      periodInits = presentation !== null && hasPeriodInits(presentation);
      holds.clear();
      inits.clear();
    }
    const site = findRendition(presentation, meta.renditionId);
    if (site === null) return data;
    const { rendition, period } = site;
    if (meta.contentType === 'text') {
      if (meta.isInit || site.track.mimeType !== 'text/vtt') return data;
      const offset = segmentAt(rendition.segments, meta.seq, period.start)?.timeOffset;
      if (offset === undefined) return data;
      const text = new TextDecoder().decode(data);
      if (text.includes('X-TIMESTAMP-MAP')) return data;
      // The header line follows the WEBVTT line (WebVTT §4.1, as HLS writes it).
      const map = `X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${Math.round(offset * MPEGTS_CLOCK)}`;
      return new TextEncoder().encode(text.replace(/^([^\r\n]*)(\r?\n)/, `$1$2${map}$2`));
    }
    if (!periodInits || (meta.contentType !== 'video' && meta.contentType !== 'audio')) return data;
    if (meta.isInit) {
      if (rendition.init !== undefined) holds.set(meta.contentType, keyOf(rendition.init));
      return data;
    }
    const need = segmentAt(rendition.segments, meta.seq, period.start)?.init ?? rendition.init;
    if (need === undefined || holds.get(meta.contentType) === keyOf(need)) return data;
    const init = await initBytes(need);
    holds.set(meta.contentType, keyOf(need));
    const joined = new Uint8Array(init.byteLength + data.byteLength);
    joined.set(init, 0);
    joined.set(data, init.byteLength);
    return joined;
  }

  ctx.registerTransform({ name: 'dash-periods', order: PERIODS_ORDER, transform });

  // A seek may drop an append in flight: what the buffer holds is unknown,
  // so the next segment brings its init.
  const onSeeking = (): void => {
    for (const type of holds.keys()) holds.set(type, null);
  };
  // A left-out period: playback reaching it moves past it.
  const skipPast = (): void => {
    if (element.seeking) return;
    const time = element.currentTime;
    const skip = skips().find((span) => time >= span.start - 0.5 && time < span.end);
    if (skip !== undefined) ctx.dispatch({ type: 'SEEK', to: skip.end + 0.05 });
  };
  element.addEventListener('seeking', onSeeking);
  for (const name of ['timeupdate', 'waiting', 'seeked']) element.addEventListener(name, skipPast);
  return () => {
    element.removeEventListener('seeking', onSeeking);
    for (const name of ['timeupdate', 'waiting', 'seeked'])
      element.removeEventListener(name, skipPast);
  };
}
