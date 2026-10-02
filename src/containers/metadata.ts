/**
 * The seam from the bytes to timed metadata, shaped like the caption
 * registry: a producer in a byte transform (the transmux's ID3 stream, an
 * emsg reader, the ID3 metadata rendition) delivers records, and the one
 * consumer, the timed-metadata stage, keeps them. A producer checks
 * `metadataWanted()` first, so a composition without the stage pays nothing.
 * Deliveries are outside the message loop, as captions are: per segment, not
 * per message.
 */
import type { MetadataEvent } from '../types/metadata.js';

export type MetadataConsumer = (events: readonly MetadataEvent[]) => void;

let consumer: MetadataConsumer | null = null;

/** Registers the metadata consumer. Returns an unregister for stage teardown. */
export function registerMetadataConsumer(fn: MetadataConsumer): () => void {
  consumer = fn;
  return () => {
    if (consumer === fn) consumer = null;
  };
}

/** True when a consumer is loaded, so a producer should extract. */
export function metadataWanted(): boolean {
  return consumer !== null;
}

/** Hands records to the consumer, if one is loaded. */
export function deliverMetadata(events: readonly MetadataEvent[]): void {
  if (events.length === 0 || consumer === null) return;
  consumer(events);
}
