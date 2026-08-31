import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fact, InflightRequest } from '../../../src/index.js';
import { createEffectRunner } from '../../../src/kernel/effects.js';
import type { FetchImpl, RetryPolicy } from '../../../src/kernel/transport.js';
import {
  backoffDelayMs,
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
