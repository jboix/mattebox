/**
 * The boundary between the transform step and where the demux actually runs.
 * A Worker keeps the hot path off the main thread; when the Worker cannot
 * start (no Worker, a strict CSP that blocks it, a chunk that fails to load),
 * the same pure transmux runs on the main thread, loaded on first need. Both
 * paths call the identical function, so the bytes match whatever route a
 * given browser takes; only the timing differs.
 */
import type { ParameterSets, TransmuxResult, TransmuxTracks, transmux } from './transmux.js';

export interface TransmuxRunnerOptions {
  /** A custom Worker URL for strict-CSP hosts that serve the chunk themselves. */
  readonly workerUrl?: string | URL;
  /** Forces synchronous main-thread execution; used by tests and headless runs. */
  readonly disableWorker?: boolean;
}

/**
 * Where the transmux comes from in the build that runs it. The npm build
 * loads the module lazily and starts the Worker chunk by URL; the script-tag
 * bundle has one compiled copy, which it calls on the main thread and starts
 * the Worker from. Either way the bytes are the same function's.
 */
export interface TransmuxSource {
  /** The transmux for the main thread, loaded the first time the Worker is not used. */
  load(): Promise<typeof transmux>;
  /** Starts the Worker this build ships; throws when it cannot. */
  worker(): Worker;
}

export interface TransmuxRunner {
  run(
    bytes: Uint8Array,
    presentationStart: number,
    wantCaptions?: boolean,
    tracks?: TransmuxTracks,
    parameterSets?: ParameterSets | null,
  ): Promise<TransmuxResult>;
  /** Which path the most recent run took, for diagnostics and the handoff. */
  path(): 'worker' | 'main';
  dispose(): void;
}

interface Request {
  readonly bytes: Uint8Array;
  readonly presentationStart: number;
  readonly wantCaptions: boolean;
  readonly tracks: TransmuxTracks;
  readonly parameterSets: ParameterSets | null;
}

interface Pending extends Request {
  resolve(result: TransmuxResult): void;
}

interface WorkerResponse {
  readonly id: number;
  readonly bytes: ArrayBuffer | null;
  readonly notTransportStream: boolean;
  readonly captions: TransmuxResult['captions'];
  readonly metadata: TransmuxResult['metadata'];
  readonly droppedAudio: boolean;
  readonly parameterSets: ParameterSets | null;
}

export function createTransmuxRunner(
  options: TransmuxRunnerOptions,
  source: TransmuxSource,
): TransmuxRunner {
  let worker: Worker | null = null;
  let workerBroken = options.disableWorker === true;
  let lastPath: 'worker' | 'main' = 'main';
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let loaded: Promise<typeof transmux> | null = null;

  /** The same pure function, on the main thread, loaded on first need. */
  async function runOnMainThread(request: Request): Promise<TransmuxResult> {
    loaded ??= source.load();
    const run = await loaded;
    return run(
      request.bytes,
      request.presentationStart,
      request.wantCaptions,
      request.tracks,
      request.parameterSets,
    );
  }

  function ensureWorker(): Worker | null {
    if (workerBroken) return null;
    if (worker !== null) return worker;
    try {
      worker =
        options.workerUrl !== undefined
          ? new Worker(options.workerUrl, { type: 'module' })
          : source.worker();
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const entry = pending.get(event.data.id);
        if (entry === undefined) return;
        pending.delete(event.data.id);
        entry.resolve({
          bytes: event.data.bytes === null ? null : new Uint8Array(event.data.bytes),
          notTransportStream: event.data.notTransportStream,
          empty: event.data.bytes === null && !event.data.notTransportStream,
          captions: event.data.captions,
          metadata: event.data.metadata,
          droppedAudio: event.data.droppedAudio,
          parameterSets: event.data.parameterSets,
        });
      };
      worker.onerror = () => {
        // A Worker that fails to start (a 404 on the chunk, a strict CSP) or
        // throws takes every subsequent run onto the main thread, and every
        // request already waiting on it is resolved there rather than left to
        // hang: a broken Worker must never stall the pipeline.
        workerBroken = true;
        worker = null;
        for (const [id, entry] of pending) {
          pending.delete(id);
          void runOnMainThread(entry).then(entry.resolve);
        }
      };
    } catch {
      workerBroken = true;
      worker = null;
    }
    return worker;
  }

  return {
    run(bytes, presentationStart, wantCaptions = false, tracks = 'all', parameterSets = null) {
      const request = { bytes, presentationStart, wantCaptions, tracks, parameterSets };
      const active = ensureWorker();
      if (active === null) {
        lastPath = 'main';
        return runOnMainThread(request);
      }
      lastPath = 'worker';
      const id = nextId;
      nextId += 1;
      const copy = bytes.slice();
      return new Promise<TransmuxResult>((resolve) => {
        // Keep the inputs on the pending entry so an onerror after this point
        // can resolve it on the main thread rather than hang.
        pending.set(id, { resolve, ...request });
        try {
          // The parameter sets are small and cloned; only the segment bytes transfer.
          active.postMessage(
            { id, bytes: copy.buffer, presentationStart, wantCaptions, tracks, parameterSets },
            [copy.buffer],
          );
        } catch {
          pending.delete(id);
          workerBroken = true;
          worker = null;
          lastPath = 'main';
          void runOnMainThread(request).then(resolve);
        }
      });
    },
    path() {
      return lastPath;
    },
    dispose() {
      worker?.terminate();
      worker = null;
      pending.clear();
    },
  };
}
