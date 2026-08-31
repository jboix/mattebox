/**
 * The diagnostic ring buffer and its tooling. Because the reducer is pure, a
 * recorded trace replays into a fresh reducer and must reproduce the same
 * effects. That turns a production stall into a deterministic regression
 * test.
 */
import type { KernelState, Reducer, TraceEntry } from '../types/kernel.js';
import type { Effect } from '../types/messages.js';

export const DEFAULT_TRACE_CAPACITY = 500;

export interface TraceBuffer {
  push(entry: TraceEntry): void;
  /** Entries oldest first. */
  snapshot(): readonly TraceEntry[];
  readonly capacity: number;
}

/** Fixed capacity, overwriting. Roughly 200 bytes of code for the whole payoff. */
export function createTraceBuffer(capacity: number = DEFAULT_TRACE_CAPACITY): TraceBuffer {
  const entries: TraceEntry[] = [];
  let head = 0;
  return {
    capacity,
    push(entry) {
      if (entries.length < capacity) {
        entries.push(entry);
      } else {
        entries[head] = entry;
        head = (head + 1) % capacity;
      }
    },
    snapshot() {
      return [...entries.slice(head), ...entries.slice(0, head)];
    },
  };
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deterministic serialization for hashing: sorted object keys, sorted Map
 * entries, opaque values tagged by constructor name. Not a wire format.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return '[function]';
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value instanceof Map) {
    const parts = [...value.entries()]
      .map(([k, v]) => `${stableStringify(k)}:${stableStringify(v)}`)
      .sort();
    return `Map{${parts.join(',')}}`;
  }
  if (value instanceof ArrayBuffer) return `ArrayBuffer(${value.byteLength})`;
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.byteLength})`;
  if (typeof value === 'object') {
    if (!isPlainObject(value)) return `[${value.constructor?.name ?? 'opaque'}]`;
    const parts = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${parts.join(',')}}`;
  }
  return String(value);
}

/** 32-bit FNV-1a over a string, as fixed-width hex. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * A cheap, stable hash of the state slices that matter for divergence
 * detection. Stable across runs: it depends only on the state.
 */
export function digest(state: KernelState): string {
  return fnv1a(
    stableStringify({
      phase: state.lifecycle.phase,
      presentation: state.presentation?.id ?? null,
      inflight: [...state.scheduling.inflight.keys()].sort(),
      bufferGoal: state.scheduling.bufferGoal,
      tokenSeq: state.scheduling.tokenSeq,
      buffers: state.buffers,
      tracks: state.tracks.active,
      quality: {
        pinned: state.quality.pinned,
        active: state.quality.active,
        constraints: [...state.quality.constraints.keys()].sort(),
      },
      currentTime: state.playback.currentTime,
    }),
  );
}

/**
 * JSON for a bug report. Byte payloads are reduced to their length and
 * non-plain objects to their constructor name; the shape of the
 * interleaving is what matters, not the media bytes.
 */
export function exportTrace(entries: readonly TraceEntry[]): string {
  return JSON.stringify(entries, (_key, value: unknown) => {
    if (value instanceof ArrayBuffer) return { $bytes: value.byteLength };
    if (ArrayBuffer.isView(value)) return { $bytes: value.byteLength };
    if (value instanceof Map) return Object.fromEntries(value);
    if (typeof value === 'function') return { $opaque: 'function' };
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      !isPlainObject(value)
    ) {
      return { $opaque: value.constructor?.name ?? 'object' };
    }
    return value;
  });
}

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i += 1) {
    if (va[i] !== vb[i]) return false;
  }
  return true;
}

/** Structural equality over effect payloads: plain data plus ArrayBuffer. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) return buffersEqual(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

export interface ReplayResult {
  readonly ok: boolean;
  /** Index of the first diverging entry, when not ok. */
  readonly divergedAt?: number;
  readonly expected?: readonly Effect[];
  readonly actual?: readonly Effect[];
}

/**
 * Feeds a recorded message sequence into a fresh reducer and checks that the
 * same effects come out. The reducer must be built with the same slices as
 * the one that produced the trace.
 */
export function replay(
  entries: readonly TraceEntry[],
  reducer: Reducer,
  initial: KernelState,
): ReplayResult {
  let state = initial;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const [next, effects] = reducer(state, entry.msg);
    if (!deepEqual(effects, entry.effects)) {
      return { ok: false, divergedAt: i, expected: entry.effects, actual: effects };
    }
    state = next;
  }
  return { ok: true };
}
