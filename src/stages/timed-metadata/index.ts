/**
 * Timed metadata from every source in one list, one API, and one native
 * track. The manifest's sources come from the IR: HLS date ranges on the
 * renditions whose playlists are loaded, merged by ID across renditions and
 * reloads (RFC 8216bis §4.4.5.1: a later tag adds attributes, never changes
 * one), and DASH EventStream events on the periods. The media's sources come
 * through the metadata registry (ID3 from the transmux or a metadata
 * rendition) and through this stage's own transform (emsg). A record whose
 * bytes are an SCTE-35 section carries a summary of it.
 *
 * The page reads `engine.metadata` and listens to `metadata:added`,
 * `metadata:enter`, and `metadata:exit`. Enter and exit follow the element's
 * time, with a timer to the next boundary because `timeupdate` fires only
 * every quarter second or so. A seek exits what it leaves and enters what it
 * lands in; an instant fires both when playback crosses it.
 *
 * Every record is mirrored to a native `metadata` TextTrack as a VTTCue whose
 * text is the record as JSON, for pages that read `textTracks`.
 */
import { readEmsg } from '../../containers/emsg.js';
import { id3Frames } from '../../containers/id3.js';
import { registerMetadataConsumer } from '../../containers/metadata.js';
import { earliestDecodeTime, findBox, trackTimescales } from '../../containers/mp4-box/index.js';
import { scte35Summary } from '../../containers/scte35.js';
import { adoptTextTrack, emptyTextTrack } from '../../kernel/sinks/text-track-sink.js';
import type { Presentation } from '../../types/ir.js';
import type { MetadataEvent } from '../../types/metadata.js';
import type { SegmentMeta } from '../../types/sink.js';
import type { Stage } from '../../types/stage.js';

export interface MetadataApi {
  /** Every record of the current source, sorted by start. */
  readonly events: readonly MetadataEvent[];
  /** The records spanning a presentation time; an instant spans its own time. */
  at(time: number): readonly MetadataEvent[];
}

declare module '../../index.js' {
  interface MatteboxNamespaces {
    metadata: MetadataApi;
  }
}

// A minimal VTTCue view; the DOM lib's shape without pulling it in here.
type CueCtor = new (start: number, end: number, text: string) => TextTrackCue;

/** After ts-transmux (100) and trick-play's fit (150): emsg rides fMP4 only. */
const EMSG_ORDER = 160;
/** The scheme of SCTE-35 sections in binary form (SCTE 214-1 §6.6). */
const SCTE35_BIN = 'urn:scte:scte35:2013:bin';
/** The scheme of ID3 tags in emsg (AOM "Carriage of ID3 Timed Metadata in CMAF"). */
const ID3_EMSG = 'https://aomedia.org/emsg/ID3';

/** The bytes of base64 text, or undefined when it is not base64. */
function base64Bytes(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text.replace(/\s+/g, ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

/** The record with the summary of its SCTE-35 section, when its bytes are one. */
function withScte35(event: MetadataEvent): MetadataEvent {
  if (event.data === undefined) return event;
  if (event.source !== 'daterange' && event.scheme !== SCTE35_BIN) return event;
  const summary = scte35Summary(event.data);
  return summary === null ? event : { ...event, scte35: summary };
}

/** The bytes of a hexadecimal-sequence (0x...), as SCTE35-CMD, -OUT, and -IN carry them. */
function hexBytes(value: string | undefined): Uint8Array | undefined {
  if (value === undefined || !/^0x[0-9a-f]*$/i.test(value) || value.length % 2 !== 0)
    return undefined;
  const out = new Uint8Array((value.length - 2) / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = Number.parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/** The manifest's records: date ranges merged by ID, then EventStream events. */
function manifestRecords(presentation: Presentation): MetadataEvent[] {
  const ranges = new Map<string, MetadataEvent>();
  const events: MetadataEvent[] = [];
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        for (const range of rendition.dateRanges ?? []) {
          const known = ranges.get(range.id);
          // A later sighting adds attributes and may close the span.
          const attributes = { ...range.attributes, ...known?.attributes };
          const end = known?.end ?? range.end ?? null;
          const data =
            hexBytes(attributes['SCTE35-OUT']) ??
            hexBytes(attributes['SCTE35-CMD']) ??
            hexBytes(attributes['SCTE35-IN']);
          ranges.set(
            range.id,
            withScte35({
              id: range.id,
              source: 'daterange',
              scheme: attributes.CLASS ?? '',
              start: known?.start ?? range.start,
              end,
              ...(range.plannedEnd !== undefined ? { plannedEnd: range.plannedEnd } : {}),
              attributes,
              ...(data !== undefined ? { data } : {}),
            }),
          );
        }
      }
    }
    for (const event of period.events ?? []) {
      // A binary SCTE-35 Event carries its section as base64; any other body is text.
      const data =
        event.data === undefined
          ? undefined
          : event.scheme === SCTE35_BIN
            ? base64Bytes(event.data)
            : new TextEncoder().encode(event.data);
      events.push(
        withScte35({
          id: `${event.scheme}|${event.id}`,
          source: 'eventstream',
          scheme: event.scheme,
          ...(event.value !== undefined ? { value: event.value } : {}),
          start: event.start,
          end: event.start + (event.duration ?? 0),
          attributes: {},
          ...(data !== undefined ? { data } : {}),
        }),
      );
    }
  }
  return [...ranges.values(), ...events];
}

/**
 * A segment's emsg boxes as records. Version 0 times from the segment's
 * start. Version 1 is on the media clock, which the kernel lands at the
 * segment's start through its earliest decode time, so it maps the same
 * way; without the init's timescales it cannot be placed and is skipped.
 * Events with the same scheme, value, and id are one event (ISO/IEC
 * 23009-1 §5.10.3.3.5), so a repeat in every segment stays one record.
 */
function emsgRecords(
  data: Uint8Array,
  meta: SegmentMeta,
  timescales: ReadonlyMap<number, number> | undefined,
): MetadataEvent[] {
  const boxes = readEmsg(data);
  if (boxes.length === 0) return [];
  const decode = timescales === undefined ? null : earliestDecodeTime(data, timescales);
  const records: MetadataEvent[] = [];
  for (const box of boxes) {
    const offset = box.time / box.timescale;
    let start: number;
    if (box.version === 0) start = meta.start + offset;
    else if (decode !== null) start = meta.start + offset - decode;
    else continue;
    // A copy, so the record does not hold the whole segment.
    const bytes = box.data.slice();
    records.push(
      withScte35({
        id: `${box.scheme}|${box.value}|${box.id}`,
        source: 'emsg',
        scheme: box.scheme,
        ...(box.value !== '' ? { value: box.value } : {}),
        start,
        end: box.duration === null ? null : start + box.duration / box.timescale,
        attributes: {},
        data: bytes,
        ...(box.scheme === ID3_EMSG ? { frames: id3Frames(bytes) } : {}),
      }),
    );
  }
  return records;
}

/** What a record says, for telling a changed record from the same one rebuilt. */
function signature(event: MetadataEvent): string {
  return `${event.start}|${event.end}|${event.plannedEnd}|${JSON.stringify(event.attributes)}|${event.data?.length ?? -1}`;
}

/** Whether a record spans a time: a span covers [start, end), an open one everything after its start. */
function spans(event: MetadataEvent, time: number): boolean {
  if (event.end === null) return time >= event.start;
  return time >= event.start && time < event.end;
}

/** The record as JSON for the native cue: bytes as hex, so the text stays readable. */
function cueText(event: MetadataEvent): string {
  const hex = (bytes: Uint8Array) =>
    [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return JSON.stringify({
    ...event,
    ...(event.data !== undefined ? { data: hex(event.data) } : {}),
    ...(event.frames !== undefined
      ? { frames: event.frames.map((f) => ({ ...f, data: hex(f.data) })) }
      : {}),
  });
}

export default function timedMetadata(): Stage {
  return {
    name: 'timed-metadata',
    provides: ['timed-metadata'],
    install(ctx) {
      const element = ctx.element;
      /** The media's records, by id; the manifest's are rebuilt from the IR. */
      const fromMedia = new Map<string, MetadataEvent>();
      let fromManifest: MetadataEvent[] = [];
      let sorted: MetadataEvent[] = [];
      let seen: Presentation | null = null;
      let sourceId: string | null = null;
      let native: TextTrack | null = null;
      const cues = new Map<string, TextTrackCue>();
      const active = new Set<string>();
      let lastTime = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;

      function reset(): void {
        fromMedia.clear();
        fromManifest = [];
        sorted = [];
        active.clear();
        cues.clear();
        if (native !== null) emptyTextTrack(native);
      }

      /** Rebuilds the list when the IR changed; emits `metadata:added` for new or changed records. */
      function refresh(): void {
        const presentation = ctx.getState().presentation;
        if (presentation === null) {
          if (seen !== null) reset();
          seen = null;
          sourceId = null;
          return;
        }
        if (presentation.id !== sourceId) {
          // A new source starts empty, whatever the last one left.
          reset();
          sourceId = presentation.id;
        }
        if (presentation !== seen) {
          seen = presentation;
          fromManifest = manifestRecords(presentation);
        }
        rebuild();
      }

      function rebuild(): void {
        const byId = new Map<string, MetadataEvent>();
        for (const event of fromManifest) byId.set(event.id, event);
        for (const event of fromMedia.values()) byId.set(event.id, event);
        // Records that ended before the live window are gone for good.
        const windowStart = ctx.getState().live?.span.start ?? Number.NEGATIVE_INFINITY;
        const next = [...byId.values()]
          .filter((event) => (event.end ?? Number.POSITIVE_INFINITY) >= windowStart)
          .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
        const before = new Map(sorted.map((event) => [event.id, signature(event)]));
        sorted = next;
        const added = next.filter((event) => before.get(event.id) !== signature(event));
        mirror(before);
        for (const event of added) ctx.emit('metadata:added', { id: event.id });
      }

      /** Keeps the native track's cues in step with the list. */
      function mirror(before: ReadonlyMap<string, string>): void {
        const VttCue = (globalThis as { VTTCue?: CueCtor }).VTTCue;
        if (VttCue === undefined) return;
        if (native === null) {
          native = adoptTextTrack(element, 'metadata', 'metadata');
          native.mode = 'hidden';
        }
        const current = new Set(sorted.map((event) => event.id));
        for (const [id, cue] of cues) {
          const event = current.has(id) ? sorted.find((e) => e.id === id) : undefined;
          if (event !== undefined && before.get(id) === signature(event)) continue;
          native.removeCue(cue);
          cues.delete(id);
        }
        for (const event of sorted) {
          if (cues.has(event.id)) continue;
          const end = event.end ?? event.start;
          const cue = new VttCue(event.start, Math.max(end, event.start), cueText(event));
          native.addCue(cue);
          cues.set(event.id, cue);
        }
      }

      /** Emits enter and exit for the playhead's move from `lastTime` to now. */
      function follow(): void {
        refresh();
        const time = element.currentTime;
        const seeked = element.seeking || Math.abs(time - lastTime) > 2;
        for (const event of sorted) {
          const instant = event.end !== null && event.end === event.start;
          if (instant) {
            // An instant fires when playback crosses it, not when a seek jumps it.
            if (!seeked && lastTime < event.start && event.start <= time) {
              ctx.emit('metadata:enter', { id: event.id });
              ctx.emit('metadata:exit', { id: event.id });
            }
            continue;
          }
          const inside = spans(event, time);
          if (inside && !active.has(event.id)) {
            active.add(event.id);
            ctx.emit('metadata:enter', { id: event.id });
          } else if (!inside && active.has(event.id)) {
            active.delete(event.id);
            ctx.emit('metadata:exit', { id: event.id });
          }
        }
        lastTime = time;
        schedule(time);
      }

      /** A timer to the next boundary ahead, so enter and exit land on time. */
      function schedule(time: number): void {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (element.paused) return;
        let next = Number.POSITIVE_INFINITY;
        for (const event of sorted) {
          if (event.start > time) next = Math.min(next, event.start);
          if (event.end !== null && event.end > time) next = Math.min(next, event.end);
        }
        if (!Number.isFinite(next)) return;
        const rate = element.playbackRate > 0 ? element.playbackRate : 1;
        timer = setTimeout(follow, Math.max(0, ((next - time) / rate) * 1000) + 10);
      }

      function take(events: readonly MetadataEvent[]): void {
        refresh();
        for (const event of events) fromMedia.set(event.id, event);
        rebuild();
        follow();
      }
      const unregister = registerMetadataConsumer(take);

      // Track timescales from each rendition's init, for version 1 emsg.
      const timescales = new Map<string, ReadonlyMap<number, number>>();
      ctx.registerTransform({
        name: 'timed-metadata-emsg',
        order: EMSG_ORDER,
        transform(data, meta) {
          if (meta.contentType !== 'video' && meta.contentType !== 'audio') return data;
          if (meta.isInit || findBox(data, 'moov') !== null) {
            const scales = trackTimescales(data);
            if (scales.size > 0) timescales.set(meta.renditionId, scales);
          }
          const records = emsgRecords(data, meta, timescales.get(meta.renditionId));
          if (records.length > 0) take(records);
          return data;
        },
      });

      const api: MetadataApi = {
        get events() {
          refresh();
          return sorted;
        },
        at(time) {
          refresh();
          return sorted.filter((event) =>
            event.end === event.start ? event.start === time : spans(event, time),
          );
        },
      };
      ctx.registerNamespace('metadata', api);

      const onTime = (): void => follow();
      for (const name of ['timeupdate', 'seeked', 'play', 'pause', 'ratechange']) {
        element.addEventListener(name, onTime);
      }
      const offChanged = ctx.on('tracks:changed', refresh);

      return () => {
        unregister();
        offChanged();
        for (const name of ['timeupdate', 'seeked', 'play', 'pause', 'ratechange']) {
          element.removeEventListener(name, onTime);
        }
        if (timer !== null) clearTimeout(timer);
        if (native !== null) {
          emptyTextTrack(native);
          native.mode = 'disabled';
          native = null;
        }
      };
    },
  };
}
