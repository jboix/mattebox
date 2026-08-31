/**
 * Per-SourceBuffer FIFO, strictly serialized on updateend. The single most
 * common MSE bug is touching a SourceBuffer while `updating` is true; every
 * operation here waits its turn.
 *
 * Quota handling: an append that throws QuotaExceededError goes back to the
 * front of the queue and the owner is notified with an attempt count. The
 * owner enqueues eviction removes with `enqueueFront`, so they run before
 * the failed append retries; queued appends behind it keep their order. The
 * attempt count resets as soon as an append succeeds, so only consecutive
 * failures escalate.
 */
import type { SbId } from '../types/kernel.js';
import type { Fact } from '../types/messages.js';

export type QueueOp =
  | { readonly op: 'append'; readonly data: ArrayBuffer }
  | { readonly op: 'remove'; readonly start: number; readonly end: number }
  | { readonly op: 'changeType'; readonly type: string }
  | { readonly op: 'setTimestampOffset'; readonly offset: number };

export interface AppendQueueCallbacks {
  absorb(fact: Fact): void;
  /** appendBuffer threw QuotaExceededError. `attempt` counts consecutive failures, starting at 1. */
  onQuota(sbId: SbId, attempt: number): void;
  /** The queue drained and the buffer is not updating. Used for deferred endOfStream. */
  onIdle(sbId: SbId): void;
}

export interface AppendQueue {
  enqueue(op: QueueOp): void;
  /** Jumps the queue. For eviction removes that must precede a retried append. */
  enqueueFront(op: QueueOp): void;
  /** sourceBuffer.abort() semantics: pending operations are dropped, not retried. */
  abort(): void;
  /** Detach teardown: drops everything and removes listeners. Idempotent. */
  destroy(): void;
  readonly idle: () => boolean;
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'QuotaExceededError';
}

function isInvalidState(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'InvalidStateError';
}

export function createAppendQueue(
  sbId: SbId,
  sb: SourceBuffer,
  cb: AppendQueueCallbacks,
): AppendQueue {
  const ops: QueueOp[] = [];
  let quotaAttempts = 0;
  let destroyed = false;
  let pumping = false;

  function execute(op: QueueOp): boolean {
    // Returns true when the operation started async work (updating went
    // true) and the pump must wait for updateend.
    try {
      switch (op.op) {
        case 'append':
          sb.appendBuffer(op.data);
          quotaAttempts = 0;
          return true;
        case 'remove': {
          // remove() throws while the duration is NaN, which it is until
          // the first append or the owner's deferred duration assignment,
          // and on a start past the buffered end. Both mean there is
          // nothing in range: a no-op, not a fatal error.
          const { buffered } = sb;
          if (buffered.length === 0 || op.start >= buffered.end(buffered.length - 1)) {
            return false;
          }
          sb.remove(op.start, op.end);
          return true;
        }
        case 'changeType':
          // Synchronous; no updateend follows.
          sb.changeType(op.type);
          return false;
        case 'setTimestampOffset':
          sb.timestampOffset = op.offset;
          return false;
      }
    } catch (err) {
      if (op.op === 'append' && isQuotaError(err)) {
        // Back to the front: order among appends is preserved, and the
        // owner's eviction removes are enqueuedFront ahead of it.
        ops.unshift(op);
        quotaAttempts += 1;
        cb.onQuota(sbId, quotaAttempts);
        return false;
      }
      if (isInvalidState(err)) {
        // The buffer was removed by a concurrent detach or the MediaSource
        // closed. The queue's world is gone: drop everything silently.
        destroy();
        return false;
      }
      cb.absorb({
        type: 'SOURCEBUFFER_ERROR',
        sbId,
        error: {
          category: 'media',
          code: 'MEDIA_APPEND_FAILED',
          fatal: true,
          recoverable: false,
          context: { operation: op.op, message: String(err) },
        },
      });
      return false;
    }
    return false;
  }

  function pump(): void {
    if (destroyed || pumping) return;
    // The guard stops onQuota reentry (it enqueues from inside execute)
    // from starting a second pump over the same queue.
    pumping = true;
    try {
      while (!sb.updating && !destroyed) {
        const op = ops.shift();
        if (op === undefined) {
          cb.onIdle(sbId);
          return;
        }
        if (execute(op)) return;
        if (op.op === 'append' && ops[0] === op) {
          // The append failed on quota and is back at the front; stop until
          // an eviction remove is enqueued or an updateend arrives, or this
          // loop would spin on the same failing append.
          return;
        }
      }
    } finally {
      pumping = false;
    }
  }

  function snapshotRanges(): Array<{ start: number; end: number }> | undefined {
    try {
      const out: Array<{ start: number; end: number }> = [];
      const { buffered } = sb;
      for (let i = 0; i < buffered.length; i += 1) {
        out.push({ start: buffered.start(i), end: buffered.end(i) });
      }
      return out;
    } catch {
      // The buffer detached between the event and the read.
      return undefined;
    }
  }

  function onUpdateEnd(): void {
    if (destroyed) return;
    const ranges = snapshotRanges();
    cb.absorb({
      type: 'SOURCEBUFFER_UPDATEEND',
      sbId,
      ...(ranges !== undefined ? { ranges } : {}),
    });
    pump();
  }

  function onError(): void {
    if (destroyed) return;
    // The segment parser rejected the bytes. updateend follows per spec;
    // the pump resumes there.
    cb.absorb({
      type: 'SOURCEBUFFER_ERROR',
      sbId,
      error: {
        category: 'media',
        code: 'MEDIA_APPEND_FAILED',
        fatal: false,
        recoverable: true,
      },
    });
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    ops.length = 0;
    sb.removeEventListener('updateend', onUpdateEnd);
    sb.removeEventListener('error', onError);
  }

  sb.addEventListener('updateend', onUpdateEnd);
  sb.addEventListener('error', onError);

  return {
    enqueue(op) {
      if (destroyed) return;
      ops.push(op);
      pump();
    },
    enqueueFront(op) {
      if (destroyed) return;
      ops.unshift(op);
      pump();
    },
    abort() {
      if (destroyed) return;
      ops.length = 0;
      quotaAttempts = 0;
      try {
        sb.abort();
      } catch {
        // InvalidStateError when the parent MediaSource is not open; the
        // queue is being torn down anyway.
      }
    },
    destroy,
    idle: () => !destroyed && ops.length === 0 && !sb.updating,
  };
}
