/**
 * Timed metadata as the page sees it: one record for every source, whether
 * the manifest declared it (HLS date ranges, DASH EventStream) or the media
 * carried it (emsg, ID3).
 */

/** One ID3 frame: its four-character id, its text when it is a text frame, its bytes. */
export interface Id3FrameView {
  readonly id: string;
  readonly value?: string;
  /** The description of a TXXX or WXXX frame. */
  readonly description?: string;
  readonly data: Uint8Array;
}

export interface MetadataEvent {
  /** Unique within the source: the date range ID, or scheme and event id, or derived from the time. */
  readonly id: string;
  readonly source: 'daterange' | 'eventstream' | 'emsg' | 'id3';
  /** The date range CLASS, the event scheme URI, or 'id3'. */
  readonly scheme: string;
  /** The EventStream or emsg value, when given. */
  readonly value?: string;
  /** Presentation time, in seconds. */
  readonly start: number;
  /** Null while a span is open (a splice out with no in yet). Equal to `start` for an instant. */
  readonly end: number | null;
  /** From a date range's PLANNED-DURATION. */
  readonly plannedEnd?: number;
  /** A date range's attributes as written; empty for the other sources. */
  readonly attributes: Readonly<Record<string, string>>;
  /** The message body: emsg message_data, Event data, the SCTE-35 section, the ID3 tag. */
  readonly data?: Uint8Array;
  /** The decoded frames of an ID3 tag. */
  readonly frames?: readonly Id3FrameView[];
  /** What a page branches on in an SCTE-35 section, when `data` is one. */
  readonly scte35?: Scte35Summary;
}

/** One segmentation_descriptor of an SCTE-35 section (SCTE 35 §10.3.3). */
export interface Scte35Segmentation {
  readonly eventId: number;
  readonly cancel: boolean;
  /** segmentation_type_id: 0x34 is a provider placement opportunity start, 0x35 its end. */
  readonly typeId?: number;
  /** In seconds. */
  readonly duration?: number;
}

/** The fields of an SCTE-35 splice_info_section a page branches on (SCTE 35 §9.6). */
export interface Scte35Summary {
  /** splice_command_type: 0 splice_null, 5 splice_insert, 6 time_signal, 7 bandwidth_reservation. */
  readonly commandType: number;
  /** splice_insert's splice_event_id. */
  readonly eventId?: number;
  readonly cancel?: boolean;
  /** splice_insert's out_of_network_indicator: true leaves the network for a break. */
  readonly outOfNetwork?: boolean;
  /** splice_insert's break_duration, in seconds. */
  readonly breakDuration?: number;
  readonly segmentations: readonly Scte35Segmentation[];
}
