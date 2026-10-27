import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeChunks } from '../../../src/containers/mp4-box/index.js';
import type { Fact, InflightRequest } from '../../../src/index.js';
import { createEffectRunner } from '../../../src/kernel/effects.js';
import type { FetchImpl, RetryPolicy } from '../../../src/kernel/transport.js';
import {
  backoffDelayMs,
  chunkedTransfer,
  createTransport,
  DEFAULT_RETRY_POLICY,
} from '../../../src/kernel/transport.js';

interface Harness {
  facts: Fact[];
  runner: ReturnType<typeof createEffectRunner>;
  calls: Array<{ url: string; headers: Record<string, string> }>;
}

function request(token: string): InflightRequest {
  return { token, trackId: 'v', seq: 3, url: 'https://cdn.example/v/3.m4s' };
}

function harness(
  fetchImpl: FetchImpl,
  options: { retry?: Partial<RetryPolicy> } = {},
): { transport: ReturnType<typeof createTransport> } & Harness {
  const facts: Fact[] = [];
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const runner = createEffectRunner();
  const transport = createTransport({
    absorb: (fact) => facts.push(fact),
    inflight: (token) => request(token),
    fetchImpl: (url, init) => {
      calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
      return fetchImpl(url, init);
    },
    now: () => Date.now(),
    ...(options.retry !== undefined ? { retry: options.retry } : {}),
  });
  transport.registerHandlers(runner);
  return { transport, facts, runner, calls };
}

function ok(bytes = 64): FetchImpl {
  return () => Promise.resolve(new Response(new ArrayBuffer(bytes), { status: 200 }));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('transport', () => {
  it('emits SEGMENT_LOADED with rtt and size on success', async () => {
    const h = harness(ok(1024));
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'https://cdn.example/v/3.m4s' }]);
    await vi.runAllTimersAsync();
    expect(h.facts).toHaveLength(1);
    expect(h.facts[0]).toMatchObject({ type: 'SEGMENT_LOADED', trackId: 'v', seq: 3, size: 1024 });
    expect(h.transport.pending()).toEqual([]);
  });

  it('sends Range headers, including the open-ended form', async () => {
    const h = harness(ok());
    h.runner.run([
      { kind: 'fetch', token: 't1', url: 'u', range: { start: 100, end: 199 } },
      { kind: 'fetch', token: 't2', url: 'u', range: { start: 500, end: Infinity } },
    ]);
    await vi.runAllTimersAsync();
    expect(h.calls[0]?.headers.Range).toBe('bytes=100-199');
    expect(h.calls[1]?.headers.Range).toBe('bytes=500-');
  });

  it('retries on retryable statuses with the exact backoff schedule, bounded', async () => {
    expect(backoffDelayMs(DEFAULT_RETRY_POLICY, 1)).toBe(500);
    expect(backoffDelayMs(DEFAULT_RETRY_POLICY, 2)).toBe(1000);
    expect(backoffDelayMs(DEFAULT_RETRY_POLICY, 9)).toBe(5000);

    let attempts = 0;
    const h = harness(() => {
      attempts += 1;
      return Promise.resolve(new Response(null, { status: 503 }));
    });
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'u' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toBe(3);
    // maxAttempts is 3: no fourth attempt, one terminal failure fact.
    await vi.runAllTimersAsync();
    expect(attempts).toBe(3);
    expect(h.facts).toHaveLength(1);
    expect(h.facts[0]).toMatchObject({
      type: 'SEGMENT_FAILED',
      status: 503,
      error: { code: 'NETWORK_HTTP_STATUS', recoverable: true },
    });
  });

  it('does not retry non-retryable statuses', async () => {
    let attempts = 0;
    const h = harness(() => {
      attempts += 1;
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'u' }]);
    await vi.runAllTimersAsync();
    expect(attempts).toBe(1);
    expect(h.facts[0]).toMatchObject({ type: 'SEGMENT_FAILED', status: 404 });
  });

  it("a stage's fetch names its rendition in the failure, so steering can count it", async () => {
    const facts: Fact[] = [];
    const runner = createEffectRunner();
    const transport = createTransport({
      absorb: (fact) => facts.push(fact),
      // A stage's fetch has no kernel request record.
      inflight: () => undefined,
      fetchImpl: () => Promise.resolve(new Response(null, { status: 403 })),
      now: () => Date.now(),
    });
    transport.registerHandlers(runner);
    runner.run([
      { kind: 'fetch', token: 'hls:pl:v2', url: 'https://cdn.example/v2.m3u8', renditionId: 'v-2' },
    ]);
    await vi.runAllTimersAsync();
    expect(facts[0]).toMatchObject({
      type: 'SEGMENT_FAILED',
      trackId: 'hls:pl:v2',
      renditionId: 'v-2',
      status: 403,
    });
  });

  it('treats a stalled request as a timeout, distinct from failure, and retries', async () => {
    let aborts = 0;
    const h = harness(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborts += 1;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
      { retry: { maxAttempts: 2 } },
    );
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'u', timeout: 1000 }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(aborts).toBe(1);
    await vi.runAllTimersAsync();
    expect(aborts).toBe(2);
    expect(h.facts[0]).toMatchObject({
      type: 'SEGMENT_FAILED',
      error: { code: 'NETWORK_TIMEOUT' },
    });
  });

  it('a body that completes after a user abort is never reported', async () => {
    // The abort lands between the headers and the end of the body. A real
    // fetch rejects the body read then; a cached or tiny response can finish
    // first, and that success must still be swallowed: the kernel already
    // dropped the request, and its bytes may belong to another rendition
    // than the refetch that replaced it.
    const h = harness(ok(512));
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'https://cdn.example/v/3.m4s' }]);
    h.runner.run([{ kind: 'abort', token: 't1' }]);
    await vi.runAllTimersAsync();
    expect(h.facts).toEqual([]);
    expect(h.transport.pending()).toEqual([]);
  });

  it('SEGMENT_LOADED carries the request token', async () => {
    const h = harness(ok(16));
    h.runner.run([{ kind: 'fetch', token: 't7', url: 'https://cdn.example/v/3.m4s' }]);
    await vi.runAllTimersAsync();
    expect(h.facts[0]).toMatchObject({ type: 'SEGMENT_LOADED', token: 't7' });
  });

  it('a user abort cancels silently, even during backoff', async () => {
    let attempts = 0;
    const h = harness(() => {
      attempts += 1;
      return Promise.resolve(new Response(null, { status: 503 }));
    });
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'u' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(attempts).toBe(1);
    expect(h.transport.pending()).toEqual(['t1']);

    // Abort lands while the retry backoff is pending.
    h.runner.run([{ kind: 'abort', token: 't1' }]);
    await vi.runAllTimersAsync();
    expect(attempts).toBe(1);
    expect(h.facts).toEqual([]);
    expect(h.transport.pending()).toEqual([]);
  });

  it('request hooks mutate the draft and response hooks observe the outcome', async () => {
    const h = harness(ok(10));
    const seen: string[] = [];
    h.transport.addRequestHook((req) => {
      req.headers['CMCD-Request'] = 'sid=abc';
      req.url = `${req.url}?steered=1`;
    });
    h.transport.addResponseHook((res) => {
      seen.push(`${res.outcome}:${res.size}`);
    });
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'https://cdn.example/v/3.m4s' }]);
    await vi.runAllTimersAsync();
    expect(h.calls[0]?.url).toBe('https://cdn.example/v/3.m4s?steered=1');
    expect(h.calls[0]?.headers['CMCD-Request']).toBe('sid=abc');
    expect(seen).toEqual(['success:10']);
  });

  it('a throwing hook does not break the request', async () => {
    const h = harness(ok());
    h.transport.addRequestHook(() => {
      throw new Error('bad hook');
    });
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'u' }]);
    await vi.runAllTimersAsync();
    expect(h.facts[0]?.type).toBe('SEGMENT_LOADED');
  });

  it('a network rejection retries and then fails with NETWORK_FAILED', async () => {
    const h = harness(() => Promise.reject(new TypeError('network down')), {
      retry: { maxAttempts: 2, baseDelayMs: 100 },
    });
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'u' }]);
    await vi.runAllTimersAsync();
    expect(h.facts[0]).toMatchObject({
      type: 'SEGMENT_FAILED',
      error: { code: 'NETWORK_FAILED' },
    });
  });
});

describe('a redirect', () => {
  /** A response the fetch reached through a redirect, as a browser reports one. */
  function redirectedTo(url: string): FetchImpl {
    return () => {
      const response = new Response(new ArrayBuffer(4), { status: 200 });
      Object.defineProperty(response, 'redirected', { value: true });
      Object.defineProperty(response, 'url', { value: url });
      return Promise.resolve(response);
    };
  }

  it('names the URL it led to on SEGMENT_LOADED, and a direct response names none', async () => {
    const h = harness(redirectedTo('https://edge.example/v/3.m4s'));
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'https://cdn.example/v/3.m4s' }]);
    await vi.runAllTimersAsync();
    expect(h.facts[0]).toMatchObject({
      type: 'SEGMENT_LOADED',
      url: 'https://edge.example/v/3.m4s',
    });
    const direct = harness(ok(4));
    direct.runner.run([{ kind: 'fetch', token: 't1', url: 'https://cdn.example/v/3.m4s' }]);
    await vi.runAllTimersAsync();
    expect(direct.facts[0]).not.toHaveProperty('url');
  });

  it('stays with a kept response, which the answer reports', async () => {
    const h = harness(ok(4));
    h.transport.prime('https://cdn.example/v/3.m4s', new ArrayBuffer(2), new Headers(), {
      redirected: 'https://edge.example/v/3.m4s',
    });
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'https://cdn.example/v/3.m4s' }]);
    await vi.runAllTimersAsync();
    expect(h.calls).toEqual([]);
    expect(h.facts[0]).toMatchObject({
      type: 'SEGMENT_LOADED',
      url: 'https://edge.example/v/3.m4s',
    });
  });
});

describe('manifest Content-Type guard', () => {
  function manifestHarness(
    fetchImpl: FetchImpl,
    accept: (contentType: string) => boolean,
    trackId = 'manifest',
  ) {
    const facts: Fact[] = [];
    const runner = createEffectRunner();
    const transport = createTransport({
      absorb: (fact) => facts.push(fact),
      inflight: (token) => ({ token, trackId, seq: 0, url: 'https://cdn.example/m' }),
      fetchImpl,
      now: () => Date.now(),
      acceptManifestType: accept,
    });
    transport.registerHandlers(runner);
    return { facts, runner, transport };
  }

  /** A response whose body reports whether anyone read it. */
  function typed(contentType: string | null) {
    let bodyRead = false;
    // highWaterMark 0: nothing is pulled until someone reads, so the flag
    // records a body read and not the stream's construction.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyRead = true;
          controller.enqueue(new Uint8Array(16));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const headers = contentType === null ? {} : { 'content-type': contentType };
    const response = new Response(body, { status: 200, headers });
    return { response, wasRead: () => bodyRead };
  }

  it('refuses a rejected Content-Type before reading the body', async () => {
    const { response, wasRead } = typed('audio/mpeg');
    const h = manifestHarness(
      () => Promise.resolve(response),
      (type) => !type.startsWith('audio/'),
    );
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'https://cdn.example/m' }]);
    await vi.runAllTimersAsync();
    expect(wasRead()).toBe(false);
    expect(h.facts).toEqual([
      {
        type: 'SEGMENT_FAILED',
        trackId: 'manifest',
        seq: 0,
        status: 200,
        error: {
          category: 'manifest',
          code: 'MANIFEST_UNSUPPORTED',
          fatal: true,
          recoverable: false,
          context: { url: 'https://cdn.example/m', token: 't1', contentType: 'audio/mpeg' },
        },
      },
    ]);
    expect(h.transport.pending()).toEqual([]);
  });

  it('an accepted or absent Content-Type downloads as before', async () => {
    for (const contentType of ['application/octet-stream', null]) {
      const { response } = typed(contentType);
      const h = manifestHarness(
        () => Promise.resolve(response),
        (type) => !type.startsWith('audio/'),
      );
      h.runner.run([{ kind: 'fetch', token: 't1', url: 'https://cdn.example/m' }]);
      await vi.runAllTimersAsync();
      expect(h.facts[0]).toMatchObject({ type: 'SEGMENT_LOADED', trackId: 'manifest', size: 16 });
    }
  });

  it('only the manifest request is checked; segments carry any type', async () => {
    const { response } = typed('audio/mpeg');
    const h = manifestHarness(
      () => Promise.resolve(response),
      () => false,
      'a',
    );
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'https://cdn.example/a/0.aac' }]);
    await vi.runAllTimersAsync();
    expect(h.facts[0]).toMatchObject({ type: 'SEGMENT_LOADED', trackId: 'a' });
  });
});

describe('primed responses', () => {
  const URL_A = 'https://cdn.example/v/3.m4s';

  it('answer a fetch of their URL once, with no network call, even when a hook changes the URL', async () => {
    const h = harness(ok(8));
    h.transport.addRequestHook((req) => {
      req.url = `${req.url}?CMCD=x`;
    });
    h.transport.prime(
      URL_A,
      new Uint8Array([1, 2, 3]).buffer,
      new Headers({ 'content-type': 'x/y' }),
    );
    h.runner.run([{ kind: 'fetch', token: 't1', url: URL_A }]);
    await vi.runAllTimersAsync();
    expect(h.calls).toEqual([]);
    expect(h.facts[0]).toMatchObject({ type: 'SEGMENT_LOADED', size: 3 });
    h.runner.run([{ kind: 'fetch', token: 't2', url: URL_A }]);
    await vi.runAllTimersAsync();
    expect(h.calls).toHaveLength(1);
  });

  it('expire after 30 s, or after the lifetime they were given', async () => {
    const h = harness(ok(8));
    h.transport.prime(URL_A, new ArrayBuffer(1), new Headers());
    vi.advanceTimersByTime(30_001);
    h.runner.run([{ kind: 'fetch', token: 't1', url: URL_A }]);
    await vi.runAllTimersAsync();
    expect(h.calls.map((c) => c.url)).toEqual([URL_A]);

    h.transport.prime(URL_A, new ArrayBuffer(1), new Headers(), { keepMs: 90_000 });
    vi.advanceTimersByTime(60_000);
    h.runner.run([{ kind: 'fetch', token: 't2', url: URL_A }]);
    await vi.runAllTimersAsync();
    expect(h.calls).toHaveLength(1);
  });

  it('keep at most 32 entries and 48 MB, the oldest dropped first', async () => {
    const h = harness(ok(8));
    for (let i = 0; i < 33; i += 1) {
      h.transport.prime(`https://cdn.example/${i}`, new ArrayBuffer(1), new Headers());
    }
    h.runner.run([
      { kind: 'fetch', token: 't1', url: 'https://cdn.example/0' },
      { kind: 'fetch', token: 't2', url: 'https://cdn.example/32' },
    ]);
    await vi.runAllTimersAsync();
    expect(h.calls.map((c) => c.url)).toEqual(['https://cdn.example/0']);

    const big = harness(ok(8));
    for (const name of ['a', 'b', 'c']) {
      big.transport.prime(
        `https://cdn.example/${name}`,
        new ArrayBuffer(20_000_000),
        new Headers(),
      );
    }
    big.runner.run([
      { kind: 'fetch', token: 't1', url: 'https://cdn.example/a' },
      { kind: 'fetch', token: 't2', url: 'https://cdn.example/c' },
    ]);
    await vi.runAllTimersAsync();
    expect(big.calls.map((c) => c.url)).toEqual(['https://cdn.example/a']);
  });

  it('answer the byte range they were kept for, and no other', async () => {
    const h = harness(ok(8));
    h.transport.prime(URL_A, new Uint8Array([1, 2]).buffer, new Headers(), {
      range: { start: 0, end: 99 },
    });
    h.runner.run([{ kind: 'fetch', token: 't1', url: URL_A, range: { start: 100, end: 199 } }]);
    await vi.runAllTimersAsync();
    expect(h.calls).toHaveLength(1);
    h.runner.run([{ kind: 'fetch', token: 't2', url: URL_A, range: { start: 0, end: 99 } }]);
    await vi.runAllTimersAsync();
    expect(h.calls).toHaveLength(1);
    expect(h.facts[1]).toMatchObject({ type: 'SEGMENT_LOADED', size: 2 });
  });

  it('report the time their own request took, so a kept segment measures the network', async () => {
    const h = harness(ok(8));
    h.transport.prime(URL_A, new ArrayBuffer(4), new Headers(), { rtt: 250 });
    h.runner.run([{ kind: 'fetch', token: 't1', url: URL_A }]);
    await vi.runAllTimersAsync();
    expect(h.facts[0]).toMatchObject({ type: 'SEGMENT_LOADED', rtt: 250 });
  });
});

describe('a channel', () => {
  const URL_A = 'https://cdn.example/v/3.m4s';

  it('sends its outcomes to its own loop, keeps each response, and names a failed request', async () => {
    const h = harness((url) =>
      Promise.resolve(new Response(new ArrayBuffer(8), { status: url.endsWith('x') ? 404 : 200 })),
    );
    const own: Fact[] = [];
    const failed: string[] = [];
    const channel = h.transport.channel({
      absorb: (fact) => own.push(fact),
      inflight: () => undefined,
      keepMs: 30_000,
      failed: (token) => failed.push(token),
    });
    channel.fetch({ kind: 'fetch', token: 'c1', url: URL_A });
    channel.fetch({ kind: 'fetch', token: 'c2', url: 'https://cdn.example/x' });
    await vi.runAllTimersAsync();

    expect(own.map((fact) => fact.type).sort()).toEqual(['SEGMENT_FAILED', 'SEGMENT_LOADED']);
    expect(h.facts).toEqual([]);
    expect(failed).toEqual(['c2']);

    h.runner.run([{ kind: 'fetch', token: 't1', url: URL_A }]);
    await vi.runAllTimersAsync();
    expect(h.calls).toHaveLength(2);
    expect(h.facts[0]).toMatchObject({ type: 'SEGMENT_LOADED', size: 8 });
  });

  it("cancels its requests on close, and leaves the engine's own alone", async () => {
    let release: (() => void) | null = null;
    const h = harness(
      (_url, init) =>
        new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          release = () => resolve(new Response(new ArrayBuffer(8), { status: 200 }));
        }),
      { retry: { maxAttempts: 1 } },
    );
    const own: Fact[] = [];
    const channel = h.transport.channel({
      absorb: (fact) => own.push(fact),
      inflight: () => undefined,
      keepMs: 30_000,
    });
    channel.fetch({ kind: 'fetch', token: 't1', url: URL_A });
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'https://cdn.example/own' }]);
    channel.close();
    (release as (() => void) | null)?.();
    await vi.runAllTimersAsync();

    expect(own).toEqual([]);
    expect(h.facts.map((fact) => fact.type)).toEqual(['SEGMENT_LOADED']);
  });
});

/** An ISO BMFF box of `size` bytes in all, header included. */
function box(type: string, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i += 1) bytes[4 + i] = type.charCodeAt(i);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** The transport with a chunk splitter and every request chunked. */
function chunkedHarness(fetchImpl: FetchImpl): Fact[] {
  const facts: Fact[] = [];
  const runner = createEffectRunner();
  const transport = createTransport({
    absorb: (fact) => facts.push(fact),
    inflight: (token) => ({ ...request(token), chunked: true }),
    fetchImpl,
    now: () => Date.now(),
    split: () => completeChunks,
  });
  transport.registerHandlers(runner);
  runner.run([{ kind: 'fetch', token: 't1', url: 'https://cdn.example/v/3.m4s' }]);
  return facts;
}

/** A body that sends each piece at its time in milliseconds after the headers. */
function timedBody(pieces: ReadonlyArray<readonly [number, Uint8Array]>): FetchImpl {
  return () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const [at, piece] of pieces) setTimeout(() => controller.enqueue(piece), at);
            const last = Math.max(...pieces.map(([at]) => at));
            setTimeout(() => controller.close(), last + 1);
          },
        }),
        { status: 200 },
      ),
    );
}

describe('chunkedTransfer, the dash.js moof timing', () => {
  it('leaves out the last chunk and needs two more', () => {
    expect(
      chunkedTransfer([
        { bytes: 1000, start: 0, end: 10 },
        { bytes: 1000, start: 20, end: 30 },
      ]),
    ).toBeNull();
  });

  it('joins chunks under a millisecond with the next ones', () => {
    const sample = chunkedTransfer([
      { bytes: 500, start: 0, end: 0 },
      { bytes: 500, start: 10, end: 20 },
      { bytes: 1000, start: 30, end: 40 },
      { bytes: 1000, start: 50, end: 60 },
    ]);
    // 1000 bytes in 10 ms twice: 100 bytes per ms.
    expect(sample).toEqual({ bytes: 2000, ms: 20 });
  });
});

describe('chunked segments', () => {
  const first = concat(box('moof', 100), box('mdat', 20_000));
  const second = concat(box('moof', 100), box('mdat', 20_000));

  it('reports each complete chunk as it arrives, then the segment', async () => {
    const facts = chunkedHarness(
      timedBody([
        [1000, first.subarray(0, 10_000)],
        [1100, first.subarray(10_000)],
        [2000, second],
      ]),
    );
    await vi.runAllTimersAsync();
    expect(facts.map((fact) => fact.type)).toEqual([
      'SEGMENT_CHUNK',
      'SEGMENT_CHUNK',
      'SEGMENT_LOADED',
    ]);
    expect((facts[0] as { bytes: ArrayBuffer }).bytes.byteLength).toBe(first.byteLength);
    expect((facts[1] as { bytes: ArrayBuffer }).bytes.byteLength).toBe(second.byteLength);
    expect(facts[2]).toMatchObject({
      bytes: new ArrayBuffer(0),
      size: first.byteLength + second.byteLength,
    });
  });

  it('measures throughput inside chunks, never across the pauses between them', async () => {
    const third = concat(box('moof', 100), box('mdat', 20_000));
    const facts = chunkedHarness(
      timedBody([
        [1000, first.subarray(0, 10_000)],
        [1100, first.subarray(10_000)],
        [2000, second.subarray(0, 10_000)],
        [2050, second.subarray(10_000)],
        [3000, third],
      ]),
    );
    await vi.runAllTimersAsync();
    // 20.1 kB in 100 ms and in 50 ms, the last chunk left out: the mean
    // of 201 and 402 bytes per ms.
    const { transfer } = facts[3] as { transfer: { bytes: number; ms: number } };
    expect(transfer.bytes).toBe(2 * first.byteLength);
    expect(transfer.bytes / transfer.ms).toBeCloseTo((201 + 402) / 2);
  });

  it('chunks that each arrive in one read measure nothing, and the segment counts its whole time', async () => {
    const facts = chunkedHarness(
      timedBody([
        [1000, first],
        [2000, second],
        [3000, first],
      ]),
    );
    await vi.runAllTimersAsync();
    expect(facts.at(-1)).not.toHaveProperty('transfer');
  });

  it('keeps an incomplete tail for the segment fact', async () => {
    const facts = chunkedHarness(timedBody([[100, concat(first, second.subarray(0, 50))]]));
    await vi.runAllTimersAsync();
    expect(facts.map((fact) => fact.type)).toEqual(['SEGMENT_CHUNK', 'SEGMENT_LOADED']);
    expect((facts[1] as { bytes: ArrayBuffer }).bytes.byteLength).toBe(50);
  });
});

describe('HEAD requests', () => {
  it('send HEAD and report the Date header', async () => {
    const methods: Array<string | undefined> = [];
    const h = harness((_url, init) => {
      methods.push(init.method);
      return Promise.resolve(
        new Response(null, { status: 200, headers: { date: 'Fri, 16 Oct 2026 20:07:50 GMT' } }),
      );
    });
    h.runner.run([{ kind: 'fetch', token: 't1', url: 'https://time.example/', method: 'HEAD' }]);
    await vi.runAllTimersAsync();
    expect(methods).toEqual(['HEAD']);
    expect(h.facts[0]).toMatchObject({
      type: 'SEGMENT_LOADED',
      serverDate: Date.parse('2026-10-16T20:07:50Z') / 1000,
    });
  });
});

describe('transport.request', () => {
  /** A fetch that answers when its signal aborts, and never otherwise. */
  const hanging: FetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });

  it('rejects with a TimeoutError past the timeout and aborts the fetch', async () => {
    const h = harness(hanging);
    const result = h.transport.request('https://lic.example/', { timeoutMs: 500 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).name).toBe('TimeoutError');
  });

  it('applies the default timeout, and a request hook can change it', async () => {
    const h = harness(hanging);
    h.transport.addRequestHook((draft) => {
      draft.timeoutMs = 100;
    });
    const result = h.transport.request('https://lic.example/', {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).name).toBe('TimeoutError');
  });

  it('rejects with the AbortError when the caller aborts', async () => {
    const h = harness(hanging);
    const controller = new AbortController();
    const result = h.transport
      .request('https://lic.example/', { signal: controller.signal, timeoutMs: null })
      .catch((e) => e);
    controller.abort();
    expect((await result).name).toBe('AbortError');
  });

  it('a response in time clears the timer', async () => {
    const h = harness(ok(8));
    const response = await h.transport.request('https://lic.example/', { timeoutMs: 500 });
    expect(response.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });
});
