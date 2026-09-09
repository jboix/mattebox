/**
 * The Worker entry. It holds no state between messages: each request carries
 * its bytes and presentation start and gets one response, so the Worker and
 * the main-thread fallback are the same pure function reached two ways. The
 * output buffer is transferred back, not copied.
 */
import type { CcPacket } from '../captions.js';
import { type TransmuxTracks, transmux } from './transmux.js';

interface Request {
  readonly id: number;
  readonly bytes: ArrayBuffer;
  readonly presentationStart: number;
  readonly wantCaptions: boolean;
  readonly tracks?: TransmuxTracks;
}

interface Response {
  readonly id: number;
  readonly bytes: ArrayBuffer | null;
  readonly notTransportStream: boolean;
  readonly captions: readonly CcPacket[];
  readonly droppedAudio: boolean;
}

// `self` is the DedicatedWorkerGlobalScope; typed minimally to avoid pulling
// the WebWorker lib into the whole package's type surface.
const scope = self as unknown as {
  onmessage: ((event: { data: Request }) => void) | null;
  postMessage(message: Response, transfer: readonly ArrayBuffer[]): void;
};

scope.onmessage = (event) => {
  const { id, bytes, presentationStart, wantCaptions, tracks = 'all' } = event.data;
  const result = transmux(new Uint8Array(bytes), presentationStart, wantCaptions, tracks);
  const out = result.bytes;
  if (out === null) {
    scope.postMessage(
      {
        id,
        bytes: null,
        notTransportStream: result.notTransportStream,
        captions: [],
        droppedAudio: result.droppedAudio,
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
      droppedAudio: result.droppedAudio,
    },
    [buffer],
  );
};
