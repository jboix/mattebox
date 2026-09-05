/**
 * MediaSource lifecycle and the effect handlers that touch it. This is the
 * boundary module: facts about the media pipeline enter the loop here, and
 * buffer effects are executed here through per-buffer append queues.
 *
 * ManagedMediaSource is preferred where available (Safari): the OS can
 * reclaim buffer under memory pressure, and some iOS paths require it.
 * The blob-URL fallback revokes in the sourceopen handler, not on detach;
 * revoking on detach is the classic leak.
 */
import type { SbId } from '../types/kernel.js';
import type { Fact, SegmentMeta } from '../types/messages.js';
import type { AppendQueue } from './append-queue.js';
import { createAppendQueue } from './append-queue.js';
import type { EffectRunner } from './effects.js';
import { createEvictor } from './evictor.js';

/** Minimal view of ManagedMediaSource; the TypeScript DOM lib does not ship it. */
type ManagedMediaSourceCtor = {
  new (): MediaSource;
  isTypeSupported(type: string): boolean;
};

function managedMediaSource(): ManagedMediaSourceCtor | undefined {
  return (globalThis as { ManagedMediaSource?: ManagedMediaSourceCtor }).ManagedMediaSource;
}

// The boundary meta a media transform receives. A transmux step reads the
// content type (which the sbId names) to know which stream it is unwrapping,
// and the presentation start to align its baseMediaDecodeTime to the
// playlist timeline. Only referenced on the appendTransform path.
function appendMeta(sbId: SbId, start: number, renditionId: string, seq: number): SegmentMeta {
  const contentType = sbId === 'sb:audio' ? 'audio' : 'video';
  return { trackId: sbId, renditionId, contentType, seq, start, duration: 0, isInit: seq < 0 };
}

/** Whether a SourceBuffer type names its codecs; a bare `video/mp4` does not. */
function declaresCodecs(type: string): boolean {
  return /codecs\s*=/i.test(type);
}

export interface MseControllerOptions {
  readonly absorb: (fact: Fact) => void;
  /** 'auto' prefers srcObject; 'object-url' forces the blob fallback (used by tests). */
  readonly attachMode?: 'auto' | 'object-url';
  /** Feature-detects by default; false forces plain MediaSource even on Safari. */
  readonly preferManaged?: boolean;
  readonly backBufferSeconds?: number;
  readonly maxEvictionPasses?: number;
  /**
   * Reads a full type from a segment's bytes. When present, a
   * createSourceBuffer effect whose type names no codecs (a bare media
   * playlist) is held until the first append, and the buffer opens with the
   * type read from those bytes. When it reads nothing, or when absent, the
   * bare type is tried as given: some browsers accept it.
   */
  readonly inferType?: (bytes: Uint8Array) => string | null;
  /**
   * Rewrites segment bytes before they reach the SourceBuffer, for the
   * transform pipeline (ts-transmux, packed-audio). Absent in every CMAF
   * composition, so the direct-enqueue path below is byte-for-byte what it
   * always was. When present, appends are serialized per buffer through a
   * promise chain so an asynchronous transform (a Worker round-trip) never
   * reorders segments.
   */
  readonly appendTransform?: (
    data: Uint8Array,
    meta: SegmentMeta,
  ) => Uint8Array | Promise<Uint8Array>;
}

export interface MseDiagnostics {
  readonly liveObjectUrls: number;
  readonly liveListeners: number;
  readonly sourceBuffers: number;
}

export interface MseController {
  /** Docs-09 attach sequence. Throws when the element is already occupied. */
  attach(el: HTMLMediaElement): void;
  /** Docs-09 detach sequence. Idempotent and safe from an error state. */
  detach(): void;
  registerHandlers(runner: EffectRunner): void;
  isManaged(): boolean;
  readyState(): ReadyState | 'detached';
  buffered(sbId: SbId): ReadonlyArray<{ start: number; end: number }>;
  diagnostics(): MseDiagnostics;
}

type ReadyState = MediaSource['readyState'];

interface TrackedBuffer {
  readonly sb: SourceBuffer;
  readonly queue: AppendQueue;
}

export function createMseController(options: MseControllerOptions): MseController {
  const { absorb } = options;
  const evictor = createEvictor({
    ...(options.backBufferSeconds !== undefined
      ? { backBufferSeconds: options.backBufferSeconds }
      : {}),
    ...(options.maxEvictionPasses !== undefined ? { maxPasses: options.maxEvictionPasses } : {}),
  });

  let element: HTMLMediaElement | null = null;
  /** sourceopen has fired for the current MediaSource. */
  let opened = false;
  /** createSourceBuffer requests that arrived before sourceopen. */
  const pendingCreates: Array<{ sbId: SbId; codecs: string }> = [];
  /** The createSourceBuffer effect handler, hoisted so sourceopen can flush the pending requests. */
  let createSourceBuffer: (effect: { sbId: SbId; codecs: string }) => void = () => {};
  let mediaSource: MediaSource | null = null;
  let managed = false;
  const buffers = new Map<SbId, TrackedBuffer>();
  // Per-buffer append ordering when a transform pipeline is loaded.
  const appendChains = new Map<SbId, Promise<void>>();
  /** Buffers requested without codecs, waiting for their first bytes to be typed. */
  const deferred = new Map<SbId, string>();
  let objectUrl: string | null = null;
  let liveObjectUrls = 0;
  let pendingEndOfStream: 'network' | 'decode' | 'none' | null = null;
  let pendingDuration: number | null = null;
  let pendingLiveRange: { start: number; end: number } | null = null;
  let unobserveManaged: (() => void) | null = null;

  // Every listener goes through these so detach can prove it removed them
  // all; "the player leaks listeners per navigation" starts with one stray
  // addEventListener.
  const tracked: Array<{ target: EventTarget; type: string; fn: EventListener }> = [];
  function listen(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    tracked.push({ target, type, fn });
  }
  function unlistenAll(): void {
    for (const { target, type, fn } of tracked) {
      target.removeEventListener(type, fn);
    }
    tracked.length = 0;
  }

  function currentTime(): number {
    return element?.currentTime ?? 0;
  }

  function readyState(): ReadyState | 'detached' {
    return mediaSource?.readyState ?? 'detached';
  }

  function allIdle(): boolean {
    for (const { queue } of buffers.values()) {
      if (!queue.idle()) return false;
    }
    return true;
  }

  /** endOfStream and duration assignment both throw while any buffer updates; run them at quiet points. */
  function runDeferredGlobalOps(): void {
    if (mediaSource === null || mediaSource.readyState !== 'open' || !allIdle()) return;
    if (pendingDuration !== null) {
      const seconds = pendingDuration;
      pendingDuration = null;
      try {
        mediaSource.duration = seconds;
      } catch {
        // The source closed between the check and the assignment; absorbed
        // by the sourceclose fact.
      }
    }
    if (pendingLiveRange !== null) {
      const { start, end } = pendingLiveRange;
      pendingLiveRange = null;
      // Only meaningful with an infinite duration; the seekable attribute
      // then reports this window instead of [0, buffered end], so native
      // controls scrub the DVR span and clamp seeks into it.
      const source = mediaSource as MediaSource & {
        setLiveSeekableRange?: (start: number, end: number) => void;
      };
      if (typeof source.setLiveSeekableRange === 'function' && end > start && start >= 0) {
        try {
          source.setLiveSeekableRange(start, end);
        } catch {
          // Closed between the check and the call, or a browser without
          // the method behind a feature flag; the next window retries.
        }
      }
    }
    if (pendingEndOfStream !== null) {
      const reason = pendingEndOfStream;
      pendingEndOfStream = null;
      try {
        if (reason === 'none') {
          mediaSource.endOfStream();
        } else {
          mediaSource.endOfStream(reason);
        }
      } catch {
        // Same race as above.
      }
    }
  }

  function onQuota(sbId: SbId, attempt: number): void {
    absorb({ type: 'QUOTA_EXCEEDED', sbId });
    const entry = buffers.get(sbId);
    if (entry === undefined) return;
    // A pass that frees nothing (playhead at 0, no back-buffer yet) would
    // leave the parked append waiting forever; skip forward to the first
    // pass with something to remove.
    let effective = attempt;
    let plan = evictor.plan(entry.sb, currentTime(), effective);
    while (plan !== null && plan.length === 0) {
      effective += 1;
      plan = evictor.plan(entry.sb, currentTime(), effective);
    }
    if (plan === null) {
      // Escalation exhausted. Surface a fatal error instead of looping.
      entry.queue.abort();
      absorb({
        type: 'SOURCEBUFFER_ERROR',
        sbId,
        error: {
          category: 'media',
          code: 'MEDIA_QUOTA_EXCEEDED',
          fatal: true,
          recoverable: false,
          context: { attempts: attempt },
        },
      });
      return;
    }
    // Front of the queue, ahead of the failed append, in plan order.
    for (let i = plan.length - 1; i >= 0; i -= 1) {
      const range = plan[i];
      if (range === undefined) continue;
      entry.queue.enqueueFront({ op: 'remove', start: range.start, end: range.end });
    }
  }

  function createQueue(sbId: SbId, sb: SourceBuffer): AppendQueue {
    return createAppendQueue(sbId, sb, {
      absorb,
      onQuota,
      onIdle: () => runDeferredGlobalOps(),
    });
  }

  function trimAllBackBuffers(): void {
    // ManagedMediaSource said streaming can stop; give memory back rather
    // than waiting for quota pressure.
    for (const [, entry] of buffers) {
      const plan = evictor.plan(entry.sb, currentTime(), 1);
      if (plan === null) continue;
      for (const range of plan) {
        entry.queue.enqueue({ op: 'remove', start: range.start, end: range.end });
      }
    }
  }

  function attach(el: HTMLMediaElement): void {
    if (element !== null) {
      throw Object.assign(new Error('already attached'), {
        category: 'config',
        code: 'CONFIG_ELEMENT_OCCUPIED',
      });
    }
    if (el.getAttribute('src') !== null || el.querySelector('source') !== null) {
      // Silent takeover of an occupied element produces unreproducible
      // races with the browser's resource selection; refuse explicitly.
      throw Object.assign(new Error('element already has a source'), {
        category: 'config',
        code: 'CONFIG_ELEMENT_OCCUPIED',
      });
    }

    // Reset the resource selection algorithm so MSE attachment cannot race
    // a previous load.
    el.removeAttribute('src');
    while (el.firstChild) el.removeChild(el.firstChild);
    el.load();

    const Managed = options.preferManaged === false ? undefined : managedMediaSource();
    managed = Managed !== undefined;
    const ms: MediaSource = Managed !== undefined ? new Managed() : new MediaSource();
    element = el;
    mediaSource = ms;
    opened = false;

    listen(ms, 'sourceopen', () => {
      if (objectUrl !== null) {
        // Revoke at sourceopen, not detach. Waiting until detach leaks the
        // MediaSource for the lifetime of the page in shipped code.
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        liveObjectUrls -= 1;
      }
      opened = true;
      absorb({ type: 'MEDIASOURCE_OPEN' });
      // Create requests that arrived while the source was still opening: a
      // load right after a reset can parse its manifest before sourceopen.
      for (const effect of pendingCreates.splice(0)) createSourceBuffer(effect);
    });
    listen(ms, 'sourceclose', () => {
      absorb({ type: 'MEDIASOURCE_CLOSED' });
    });
    if (managed) {
      unobserveManaged = evictor.observeManaged(ms, trimAllBackBuffers);
      // Safari requires remote playback disabled before it will open a
      // ManagedMediaSource.
      el.disableRemotePlayback = true;
    }

    let useSrcObject = options.attachMode !== 'object-url' && 'srcObject' in el;
    if (useSrcObject) {
      try {
        el.srcObject = ms as unknown as MediaProvider;
        useSrcObject = el.srcObject === (ms as unknown as MediaProvider);
      } catch {
        useSrcObject = false;
      }
    }
    if (!useSrcObject) {
      objectUrl = URL.createObjectURL(ms);
      liveObjectUrls += 1;
      el.src = objectUrl;
    }

    absorb({ type: 'ELEMENT_ATTACHED', element: el });
  }

  function detach(): void {
    if (element === null && mediaSource === null) return;
    const el = element;
    const ms = mediaSource;

    for (const [, entry] of buffers) {
      if (ms !== null && ms.readyState === 'open') {
        entry.queue.abort();
      }
      entry.queue.destroy();
      if (ms !== null && ms.readyState === 'open') {
        try {
          ms.removeSourceBuffer(entry.sb);
        } catch {
          // Already detached from the MediaSource; nothing to remove.
        }
      }
    }
    buffers.clear();
    appendChains.clear();
    deferred.clear();
    pendingCreates.length = 0;

    if (ms !== null && ms.readyState === 'open') {
      try {
        ms.endOfStream();
      } catch {
        // A buffer race can close the source first; the goal is reached.
      }
    }

    unobserveManaged?.();
    unobserveManaged = null;
    unlistenAll();

    if (el !== null) {
      if ('srcObject' in el) el.srcObject = null;
      el.removeAttribute('src');
      if (objectUrl !== null) {
        // sourceopen never fired (attach aborted early); do not leak the URL.
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        liveObjectUrls -= 1;
      }
      el.load();
    }

    element = null;
    mediaSource = null;
    managed = false;
    pendingEndOfStream = null;
    pendingDuration = null;
    pendingLiveRange = null;
  }

  /** Adds the SourceBuffer, reporting creation or a clean codec error. */
  function open(sbId: SbId, type: string): boolean {
    const ms = mediaSource;
    if (ms === null) return false;
    try {
      // `type` is the full content type, e.g. 'video/mp4; codecs="avc1.42c01e"'.
      const sb = ms.addSourceBuffer(type);
      buffers.set(sbId, { sb, queue: createQueue(sbId, sb) });
      absorb({ type: 'SOURCEBUFFER_CREATED', sbId, codecs: type });
      return true;
    } catch (err) {
      // A bogus codec string surfaces as a MatteboxError fact, never as a
      // DOMException escaping into user code.
      absorb({
        type: 'SOURCEBUFFER_ERROR',
        sbId,
        error: {
          category: 'media',
          code: 'MEDIA_CODEC_UNSUPPORTED',
          fatal: false,
          recoverable: false,
          context: { codecs: type, message: String(err) },
        },
      });
      return false;
    }
  }

  /**
   * Hands bytes to the buffer's queue, first opening a deferred buffer with
   * the type the probe reads from them, or with the bare type when the probe
   * reads nothing, which is what an unprobed composition does from the
   * start. Bytes for a buffer that does not exist and is not deferred are
   * dropped, as before.
   */
  function enqueueAppend(sbId: SbId, data: ArrayBuffer): void {
    const bare = deferred.get(sbId);
    if (bare !== undefined && !buffers.has(sbId)) {
      deferred.delete(sbId);
      const type = options.inferType?.(new Uint8Array(data)) ?? bare;
      if (!open(sbId, type)) return;
    }
    buffers.get(sbId)?.queue.enqueue({ op: 'append', data });
  }

  function registerHandlers(runner: EffectRunner): void {
    createSourceBuffer = (effect) => {
      const ms = mediaSource;
      if (ms !== null && !opened && ms.readyState === 'closed') {
        // Attached, sourceopen still pending: the request waits for it.
        pendingCreates.push(effect);
        return;
      }
      if (ms === null || ms.readyState !== 'open') {
        absorb({
          type: 'SOURCEBUFFER_ERROR',
          sbId: effect.sbId,
          error: {
            category: 'media',
            code: 'MEDIA_SOURCE_CLOSED',
            fatal: false,
            recoverable: true,
            context: { readyState: readyState() },
          },
        });
        return;
      }
      if (buffers.has(effect.sbId) || deferred.has(effect.sbId)) {
        // Already created or awaiting its first bytes; a duplicate request
        // is absorbed, not doubled.
        return;
      }
      if (options.inferType !== undefined && !declaresCodecs(effect.codecs)) {
        // Chrome refuses a bare `video/mp4`; the first segment says what
        // it holds. The buffer opens on that append, typed from the bytes.
        deferred.set(effect.sbId, effect.codecs);
        return;
      }
      open(effect.sbId, effect.codecs);
      return;
    };
    runner.register('createSourceBuffer', (effect) => {
      createSourceBuffer(effect);
      return undefined;
    });

    runner.register('resetSource', () => {
      // UNLOAD: the source and its buffers go, and the element gets a fresh
      // MediaSource so the next load starts from nothing, on a reset
      // element (currentTime 0, no ranges).
      const el = element;
      if (el === null) return undefined;
      detach();
      attach(el);
      return undefined;
    });

    runner.register('append', (effect) => {
      const { appendTransform } = options;
      if (appendTransform === undefined) {
        enqueueAppend(effect.sbId, effect.data);
        return undefined;
      }
      // A transform pipeline is loaded. Serialize per buffer so a Worker
      // round-trip cannot let segment N+1 land before segment N. The chain
      // holds arrival order; the queue then holds append order.
      const prior = appendChains.get(effect.sbId) ?? Promise.resolve();
      const next = prior
        .then(async () => {
          const out = await appendTransform(
            new Uint8Array(effect.data),
            appendMeta(effect.sbId, effect.start ?? 0, effect.renditionId ?? '', effect.seq ?? 0),
          );
          const bytes =
            out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
              ? (out.buffer as ArrayBuffer)
              : (out.slice().buffer as ArrayBuffer);
          enqueueAppend(effect.sbId, bytes);
        })
        .catch((err) => {
          // A transmux failure is a container error, never a throw or a hang.
          absorb({
            type: 'SOURCEBUFFER_ERROR',
            sbId: effect.sbId,
            error: {
              category: 'media',
              code: 'MEDIA_CONTAINER_INVALID',
              fatal: false,
              recoverable: false,
              context: { message: String(err) },
            },
          });
        });
      appendChains.set(effect.sbId, next);
      return undefined;
    });

    // With a transform pipeline loaded, appends reach the queue only after
    // an async hop. Every other buffer operation must take the same hop,
    // or a remove or offset change emitted after an append runs before it:
    // a switch's flush would then land under the segment it meant to cut,
    // and the decoder would meet one rendition's frames under another's
    // init segment.
    function sequenced(sbId: SbId, op: () => void): void {
      if (options.appendTransform === undefined) {
        op();
        return;
      }
      const prior = appendChains.get(sbId) ?? Promise.resolve();
      appendChains.set(
        sbId,
        prior.then(op).catch(() => undefined),
      );
    }

    runner.register('remove', (effect) => {
      sequenced(effect.sbId, () => {
        const entry = buffers.get(effect.sbId);
        if (entry === undefined) return;
        const clamped = evictor.clamp(entry.sb, effect.start, effect.end, currentTime());
        if (clamped === null) return;
        entry.queue.enqueue({ op: 'remove', start: clamped.start, end: clamped.end });
      });
      return undefined;
    });

    runner.register('changeType', (effect) => {
      sequenced(effect.sbId, () => {
        buffers.get(effect.sbId)?.queue.enqueue({ op: 'changeType', type: effect.codecs });
      });
      return undefined;
    });

    runner.register('setTimestampOffset', (effect) => {
      sequenced(effect.sbId, () => {
        buffers
          .get(effect.sbId)
          ?.queue.enqueue({ op: 'setTimestampOffset', offset: effect.offset });
      });
      return undefined;
    });

    runner.register('endOfStream', (effect) => {
      if (mediaSource === null || mediaSource.readyState !== 'open') {
        // Calling endOfStream on a closed or ended source is an
        // InvalidStateError; the stream is already not open, so the intent
        // is moot. Deliberate no-op.
        return undefined;
      }
      pendingEndOfStream = effect.reason ?? 'none';
      runDeferredGlobalOps();
      return undefined;
    });

    runner.register('setDuration', (effect) => {
      if (mediaSource === null || mediaSource.readyState !== 'open') return undefined;
      pendingDuration = effect.seconds;
      runDeferredGlobalOps();
      return undefined;
    });

    runner.register('setLiveSeekableRange', (effect) => {
      if (mediaSource === null || mediaSource.readyState !== 'open') return undefined;
      pendingLiveRange = { start: effect.start, end: effect.end };
      runDeferredGlobalOps();
      return undefined;
    });
  }

  return {
    attach,
    detach,
    registerHandlers,
    isManaged: () => managed,
    readyState,
    buffered(sbId) {
      const entry = buffers.get(sbId);
      if (entry === undefined) return [];
      const out: Array<{ start: number; end: number }> = [];
      const { buffered } = entry.sb;
      for (let i = 0; i < buffered.length; i += 1) {
        out.push({ start: buffered.start(i), end: buffered.end(i) });
      }
      return out;
    },
    diagnostics() {
      return {
        liveObjectUrls,
        liveListeners: tracked.length,
        sourceBuffers: buffers.size,
      };
    },
  };
}
