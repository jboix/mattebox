/**
 * The abr-persist storage the presets inject: localStorage, guarded. The
 * stage itself never assumes a storage exists (TV runtimes and privacy
 * modes throw on access); a preset has to pick one, and a throwing or
 * absent localStorage degrades to remembering nothing.
 */
import type { AbrPersistStorage } from '../stages/abr-persist/index.js';

const KEY = 'mattebox:throughput';

export function localThroughputStorage(key: string = KEY): AbrPersistStorage {
  return {
    get() {
      try {
        const value = globalThis.localStorage?.getItem(key);
        const bps = value === null || value === undefined ? Number.NaN : Number(value);
        return Number.isFinite(bps) && bps > 0 ? bps : null;
      } catch {
        return null;
      }
    },
    set(bps) {
      try {
        globalThis.localStorage?.setItem(key, String(Math.round(bps)));
      } catch {
        // Quota, privacy mode, or no storage: forgetting is the documented fallback.
      }
    },
  };
}
