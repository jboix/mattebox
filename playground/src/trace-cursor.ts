/**
 * A cursor over the engine's trace ring buffer: hands out entries that
 * arrived since the last read, by object identity, and falls back to the
 * clock when the ring has already evicted the last one seen.
 */
import type { Mattebox, TraceEntry } from '../../src/index.js';

export interface TraceCursor {
  reset(engine: Mattebox | null): void;
  /** New entries since the previous call, oldest first. */
  read(): readonly TraceEntry[];
}

export function createTraceCursor(): TraceCursor {
  let engine: Mattebox | null = null;
  let last: TraceEntry | null = null;
  let lastT = -1;
  return {
    reset(next) {
      engine = next;
      last = null;
      lastT = -1;
    },
    read() {
      if (engine === null) return [];
      const trace = engine.stats.trace();
      let start = 0;
      if (last !== null) {
        const index = trace.indexOf(last);
        start = index >= 0 ? index + 1 : trace.findIndex((e) => e.t > lastT);
        if (start < 0) start = trace.length;
      }
      const fresh = trace.slice(start);
      const tail = fresh[fresh.length - 1];
      if (tail !== undefined) {
        last = tail;
        lastT = tail.t;
      }
      return fresh;
    },
  };
}
