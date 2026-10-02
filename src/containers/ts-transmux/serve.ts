/**
 * The Worker's side of the transmux: it answers each request with one
 * response and holds no state between them, so the Worker and the
 * main-thread fallback are the same pure function reached two ways. The
 * output buffer is transferred back, not copied.
 */
import type { CcPacket } from '../captions.js';
import { type ParameterSets, type TimedTag, type TransmuxTracks, transmux } from './transmux.js';

export interface TransmuxRequest {
  readonly id: number;
  readonly bytes: ArrayBuffer;
  readonly presentationStart: number;
  readonly wantCaptions: boolean;
  readonly tracks?: TransmuxTracks;
  readonly parameterSets?: ParameterSets | null;
}

export interface TransmuxResponse {
  readonly id: number;
  readonly bytes: ArrayBuffer | null;
  readonly notTransportStream: boolean;
  readonly captions: readonly CcPacket[];
  readonly metadata: readonly TimedTag[];
  readonly droppedAudio: boolean;
  readonly parameterSets: ParameterSets | null;
}

/** The DedicatedWorkerGlobalScope, typed minimally to keep the WebWorker lib out of the package. */
export interface TransmuxScope {
  onmessage: ((event: { data: TransmuxRequest }) => void) | null;
  postMessage(message: TransmuxResponse, transfer: readonly ArrayBuffer[]): void;
}

/** Answers transmux requests on a Worker's scope. */
export function serveTransmux(scope: TransmuxScope): void {
  scope.onmessage = (event) => {
    const { id, bytes, presentationStart, wantCaptions, tracks = 'all' } = event.data;
    const result = transmux(
      new Uint8Array(bytes),
      presentationStart,
      wantCaptions,
      tracks,
      event.data.parameterSets ?? null,
    );
    const out = result.bytes;
    if (out === null) {
      scope.postMessage(
        {
          id,
          bytes: null,
          notTransportStream: result.notTransportStream,
          captions: [],
          metadata: [],
          droppedAudio: result.droppedAudio,
          parameterSets: null,
        },
        [],
      );
      return;
    }
    const buffer = new ArrayBuffer(out.byteLength);
    new Uint8Array(buffer).set(out);
    scope.postMessage(
      {
        id,
        bytes: buffer,
        notTransportStream: false,
        captions: result.captions,
        metadata: result.metadata,
        droppedAudio: result.droppedAudio,
        parameterSets: result.parameterSets,
      },
      [buffer],
    );
  };
}
