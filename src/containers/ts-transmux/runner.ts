/**
 * The boundary between the transform step and where the demux actually runs.
 * A Worker keeps the hot path off the main thread; when the build cannot emit
 * a Worker chunk, or the environment has no Worker, or a custom-URL Worker
 * fails to start, the same pure transmux runs synchronously on the main
 * thread. Both paths call the identical function, so the bytes match whatever
 * route a given browser takes; only the timing differs.
 */
import { type TransmuxResult, transmux } from './transmux.js';

export interface TransmuxRunnerOptions {
  /** A custom Worker URL for strict-CSP hosts that serve the chunk themselves. */
  readonly workerUrl?: string | URL;
  /** Forces synchronous main-thread execution; used by tests and headless runs. */
  readonly disableWorker?: boolean;
}

export interface TransmuxRunner {
  run(
    bytes: Uint8Array,
    presentationStart: number,
    wantCaptions?: boolean,
  ): Promise<TransmuxResult>;
  /** Which path the most recent run took, for diagnostics and the handoff. */
  path(): 'worker' | 'main';
  dispose(): void;
}

interface Pending {
  resolve(result: TransmuxResult): void;
  readonly bytes: Uint8Array;
  readonly presentationStart: number;
  readonly wantCaptions: boolean;
}

interface WorkerResponse {
  readonly id: number;
  readonly bytes: ArrayBuffer | null;
  readonly notTransportStream: boolean;
  readonly captions: TransmuxResult['captions'];
}

function runOnMainThread(
  bytes: Uint8Array,
  presentationStart: number,
  wantCaptions: boolean,
): TransmuxResult {
  return transmux(bytes, presentationStart, wantCaptions);
}

export function createTransmuxRunner(options: TransmuxRunnerOptions = {}): TransmuxRunner {
  let worker: Worker | null = null;
  let workerBroken = options.disableWorker === true;
  let lastPath: 'worker' | 'main' = 'main';
  let nextId = 1;
  const pending = new Map<number, Pending>();

  function ensureWorker(): Worker | null {
    if (workerBroken) return null;
    if (worker !== null) return worker;
    try {
      worker =
        options.workerUrl !== undefined
          ? new Worker(options.workerUrl, { type: 'module' })
          : new Worker(new URL('./transmux.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const entry = pending.get(event.data.id);
        if (entry === undefined) return;
        pending.delete(event.data.id);
        entry.resolve({
          bytes: event.data.bytes === null ? null : new Uint8Array(event.data.bytes),
          notTransportStream: event.data.notTransportStream,
          empty: event.data.bytes === null && !event.data.notTransportStream,
          captions: event.data.captions,
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
          entry.resolve(runOnMainThread(entry.bytes, entry.presentationStart, entry.wantCaptions));
        }
      };
    } catch {
      workerBroken = true;
      worker = null;
    }
    return worker;
  }

  return {
    run(bytes, presentationStart, wantCaptions = false) {
      const active = ensureWorker();
      if (active === null) {
        lastPath = 'main';
        return Promise.resolve(runOnMainThread(bytes, presentationStart, wantCaptions));
      }
      lastPath = 'worker';
      const id = nextId;
      nextId += 1;
      const copy = bytes.slice();
      return new Promise<TransmuxResult>((resolve) => {
        // Keep the inputs on the pending entry so an onerror after this point
        // can resolve it on the main thread rather than hang.
        pending.set(id, { resolve, bytes, presentationStart, wantCaptions });
        try {
          active.postMessage({ id, bytes: copy.buffer, presentationStart, wantCaptions }, [
            copy.buffer,
          ]);
        } catch {
          pending.delete(id);
          workerBroken = true;
          worker = null;
          lastPath = 'main';
          resolve(runOnMainThread(bytes, presentationStart, wantCaptions));
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
