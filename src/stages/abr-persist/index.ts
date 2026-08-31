/**
 * Bandwidth memory across sessions, for the startup rendition choice.
 * Storage is injected, never assumed: TV environments and privacy modes
 * break localStorage, so the consumer supplies the get/set pair and this
 * stage stays storage-agnostic.
 *
 * Seeding rides the message loop: a remembered figure loops back as a
 * THROUGHPUT_SAMPLE fact on LOAD, priming both EWMAs before the first real
 * byte. Persisting crosses the pure boundary the only allowed way: the
 * slice emits an event effect and the install-time listener writes.
 */
import type { SliceReducer } from '../../types/kernel.js';
import type { Effect } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';

export interface AbrPersistStorage {
  /** The remembered estimate in bits per second, or null for none. */
  get(): number | null;
  set(bps: number): void;
}

interface PersistSlice {
  readonly seeded: boolean;
  readonly lastSaved: number;
}

const INITIAL: PersistSlice = { seeded: false, lastSaved: 0 };

const SAVE_EVENT = 'abr-persist:save';

/** Relative drift that triggers a save. */
const DRIFT = 0.2;

export default function abrPersist(storage: AbrPersistStorage): Stage {
  return {
    name: 'abr-persist',
    requires: ['abr'],
    install(ctx) {
      const remembered = storage.get();
      const reduce: SliceReducer<PersistSlice> = (slice, msg, kernel) => {
        const state = slice ?? INITIAL;
        if (msg.type === 'LOAD' && !state.seeded && remembered !== null && remembered > 0) {
          const effects: Effect[] = [
            {
              kind: 'schedule',
              token: 'abr-persist:seed',
              delayMs: 0,
              // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
              then: { type: 'THROUGHPUT_SAMPLE', bps: remembered, trackId: 'abr-persist' },
            },
          ];
          return [{ ...state, seeded: true, lastSaved: remembered }, effects];
        }
        if (msg.type === 'SEGMENT_LOADED') {
          const current = kernel.stats.throughputEwma;
          if (current > 0 && Math.abs(current - state.lastSaved) > state.lastSaved * DRIFT) {
            return [
              { ...state, lastSaved: current },
              [{ kind: 'emit', event: SAVE_EVENT, payload: current }],
            ];
          }
        }
        return [state, []];
      };
      ctx.reduce('abr-persist', reduce as SliceReducer);
      return ctx.on(SAVE_EVENT, (bps) => {
        if (typeof bps === 'number') storage.set(Math.round(bps));
      });
    },
  };
}
