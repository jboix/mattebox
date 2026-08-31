/**
 * The fetch wrapper. Executes fetch effects, feeds results back as facts,
 * and owns per-token AbortControllers so the abort effect can target any
 * request, including one stalled in a timeout or waiting out a backoff.
 *
 * Extension points, used by cmcd, content-steering, and the playground's
 * fault injector:
 * - request hooks mutate a draft (url, headers, timeout) before dispatch
 * - response hooks observe the outcome (status, rtt, size) after it
 * - fetchImpl replaces the network entirely, which is how tests and the
 *   fault injector produce deterministic bad networks
 *
 * Example:
 *   transport.addRequestHook((req) => {
 *     req.headers['CMCD-Request'] = `sid=${sessionId}`;
 *   });
 */
import type { InflightRequest } from '../types/kernel.js';
import type { Fact } from '../types/messages.js';
import type { EffectRunner } from './effects.js';

/** Retry policy as data, not code. */
export interface RetryPolicy {
  /** Total attempts including the first. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
  /** HTTP statuses worth retrying. Network errors and timeouts always retry. */
  readonly retryStatuses: readonly number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 5_000,
  retryStatuses: [408, 429, 500, 502, 503, 504],
};

/** Backoff delay before retry `attempt` (1 = first retry). Exported so tests pin the schedule. */
export function backoffDelayMs(policy: RetryPolicy, attempt: number): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.factor ** (attempt - 1));
}

/** The mutable draft request hooks receive before dispatch. */
export interface TransportRequestDraft {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number | null;
  readonly token: string;
  readonly attempt: number;
}

export interface TransportResponseInfo {
  readonly token: string;
  readonly url: string;
  readonly status: number | null;
  readonly rtt: number;
  readonly size: number;
  readonly outcome: 'success' | 'failure' | 'timeout';
  readonly attempt: number;
}

export type RequestHook = (req: TransportRequestDraft) => void;
export type ResponseHook = (res: TransportResponseInfo) => void;

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  readonly absorb: (fact: Fact) => void;
  /** Correlates a token with its request record from kernel state. */
  readonly inflight: (token: string) => InflightRequest | undefined;
  readonly retry?: Partial<RetryPolicy>;
  /** Default timeout when the fetch effect carries none. Null disables. */
  readonly defaultTimeoutMs?: number | null;
  readonly fetchImpl?: FetchImpl;
  readonly now?: () => number;
  /**
   * Decides from the response Content-Type whether the manifest request's
   * body is worth reading. Returning false fails the request as an
   * unsupported manifest before the body downloads, so an audio file
   * handed to `load` costs one round of headers, not the whole file. Only
   * the request on the `manifest` track is checked; segments never are.
   */
  readonly acceptManifestType?: (contentType: string) => boolean;
}

export interface Transport {
  registerHandlers(runner: EffectRunner): void;
  addRequestHook(hook: RequestHook): () => void;
  addResponseHook(hook: ResponseHook): () => void;
  /**
   * A one-off request through the same request hooks and fetchImpl as
   * segments, for license and steering fetches. Not correlated to a token
   * or the reducer; the caller awaits the Response directly.
   */
  request(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: ArrayBuffer | Uint8Array | string;
    },
  ): Promise<Response>;
  /** Tokens with live network activity or a pending retry. For tests and diagnostics. */
  pending(): readonly string[];
}

interface LiveRequest {
  controller: AbortController;
  timedOut: boolean;
  userAborted: boolean;
  timeoutId: ReturnType<typeof setTimeout> | null;
  retryId: ReturnType<typeof setTimeout> | null;
}

export function createTransport(options: TransportOptions): Transport {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const fetchImpl: FetchImpl = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const now = options.now ?? (() => globalThis.performance.now());
  const defaultTimeout = options.defaultTimeoutMs === undefined ? 20_000 : options.defaultTimeoutMs;

  const requestHooks = new Set<RequestHook>();
  const responseHooks = new Set<ResponseHook>();
  const live = new Map<string, LiveRequest>();

  function fail(
    token: string,
    request: InflightRequest,
    code: 'NETWORK_TIMEOUT' | 'NETWORK_HTTP_STATUS' | 'NETWORK_FAILED',
    status?: number,
  ): void {
    live.delete(token);
    options.absorb({
      type: 'SEGMENT_FAILED',
      trackId: request.trackId,
      seq: request.seq,
      ...(request.renditionId !== undefined ? { renditionId: request.renditionId } : {}),
      ...(status !== undefined ? { status } : {}),
      error: {
        category: 'network',
        code,
        fatal: false,
        recoverable: true,
        context: { url: request.url, token },
      },
    });
  }

  function notifyResponse(info: TransportResponseInfo): void {
    for (const hook of [...responseHooks]) {
      try {
        hook(info);
      } catch {
        // A broken hook must not break the pipeline.
      }
    }
  }

  function attempt(
    token: string,
    request: InflightRequest,
    effectUrl: string,
    range: { start: number; end: number } | undefined,
    timeoutFromEffect: number | undefined,
    attemptNo: number,
  ): void {
    const state: LiveRequest = {
      controller: new AbortController(),
      timedOut: false,
      userAborted: false,
      timeoutId: null,
      retryId: null,
    };
    live.set(token, state);

    const draft: TransportRequestDraft = {
      url: effectUrl,
      headers: {},
      timeoutMs: timeoutFromEffect ?? defaultTimeout,
      token,
      attempt: attemptNo,
    };
    if (range !== undefined) {
      // Open-ended when end is not finite: `bytes=123-`.
      const end = Number.isFinite(range.end) ? String(range.end) : '';
      draft.headers.Range = `bytes=${range.start}-${end}`;
    }
    for (const hook of [...requestHooks]) {
      try {
        hook(draft);
      } catch {
        // A broken hook must not break the request.
      }
    }

    if (draft.timeoutMs !== null) {
      state.timeoutId = setTimeout(() => {
        // A stalled request distinct from a failed one: mark, then abort so
        // the fetch rejects promptly instead of hanging.
        state.timedOut = true;
        state.controller.abort();
      }, draft.timeoutMs);
    }

    const startedAt = now();

    const retryOrFail = (
      code: 'NETWORK_TIMEOUT' | 'NETWORK_HTTP_STATUS' | 'NETWORK_FAILED',
      status?: number,
    ): void => {
      const retryable =
        attemptNo < policy.maxAttempts &&
        (code !== 'NETWORK_HTTP_STATUS' ||
          (status !== undefined && policy.retryStatuses.includes(status)));
      if (!retryable) {
        fail(token, request, code, status);
        return;
      }
      state.retryId = setTimeout(
        () => {
          state.retryId = null;
          attempt(token, request, effectUrl, range, timeoutFromEffect, attemptNo + 1);
        },
        backoffDelayMs(policy, attemptNo),
      );
    };

    fetchImpl(draft.url, { headers: draft.headers, signal: state.controller.signal })
      .then(async (response) => {
        if (state.timeoutId !== null) clearTimeout(state.timeoutId);
        if (!response.ok) {
          notifyResponse({
            token,
            url: draft.url,
            status: response.status,
            rtt: now() - startedAt,
            size: 0,
            outcome: 'failure',
            attempt: attemptNo,
          });
          retryOrFail('NETWORK_HTTP_STATUS', response.status);
          return;
        }
        // A refused manifest Content-Type never reads the body: the
        // headers were the whole cost of finding out.
        const contentType = response.headers.get('content-type');
        const refused =
          request.trackId === 'manifest' &&
          contentType !== null &&
          options.acceptManifestType?.(contentType) === false;
        if (refused) await response.body?.cancel();
        const bytes = refused ? new ArrayBuffer(0) : await response.arrayBuffer();
        if (state.userAborted) {
          // The body finished before the abort took effect. The kernel
          // dropped this request already; reporting it would hand another
          // rendition's bytes to whatever replaced it.
          live.delete(token);
          return;
        }
        const rtt = now() - startedAt;
        notifyResponse({
          token,
          url: draft.url,
          status: response.status,
          rtt,
          size: bytes.byteLength,
          outcome: refused ? 'failure' : 'success',
          attempt: attemptNo,
        });
        live.delete(token);
        if (refused) {
          options.absorb({
            type: 'SEGMENT_FAILED',
            trackId: request.trackId,
            seq: request.seq,
            status: response.status,
            error: {
              category: 'manifest',
              code: 'MANIFEST_UNSUPPORTED',
              fatal: true,
              recoverable: false,
              context: { url: request.url, token, contentType },
            },
          });
          return;
        }
        options.absorb({
          type: 'SEGMENT_LOADED',
          trackId: request.trackId,
          seq: request.seq,
          token,
          bytes,
          rtt,
          size: bytes.byteLength,
          // Wall time at receipt: the live stages' clock input.
          wallClock: Date.now() / 1000,
        });
      })
      .catch(() => {
        if (state.timeoutId !== null) clearTimeout(state.timeoutId);
        if (state.userAborted) {
          // The kernel already dropped this request when it emitted the
          // abort; a fact here would be noise about a corpse.
          live.delete(token);
          return;
        }
        const outcome = state.timedOut ? 'timeout' : 'failure';
        notifyResponse({
          token,
          url: draft.url,
          status: null,
          rtt: now() - startedAt,
          size: 0,
          outcome,
          attempt: attemptNo,
        });
        retryOrFail(state.timedOut ? 'NETWORK_TIMEOUT' : 'NETWORK_FAILED');
      });
  }

  function cancel(token: string): void {
    const state = live.get(token);
    if (state === undefined) return;
    state.userAborted = true;
    if (state.timeoutId !== null) clearTimeout(state.timeoutId);
    if (state.retryId !== null) {
      clearTimeout(state.retryId);
      live.delete(token);
      return;
    }
    state.controller.abort();
  }

  return {
    registerHandlers(runner: EffectRunner): void {
      runner.register('fetch', (effect) => {
        // With no request record, the token itself becomes the trackId so
        // whoever issued the effect can correlate the resulting fact.
        const request = options.inflight(effect.token) ?? {
          token: effect.token,
          trackId: effect.token,
          seq: -1,
          url: effect.url,
        };
        attempt(effect.token, request, effect.url, effect.range, effect.timeout, 1);
        return () => cancel(effect.token);
      });
    },
    async request(url, init) {
      const draft: TransportRequestDraft = {
        url,
        headers: { ...(init.headers ?? {}) },
        timeoutMs: defaultTimeout,
        token: `req:${url}`,
        attempt: 1,
      };
      for (const hook of [...requestHooks]) {
        try {
          hook(draft);
        } catch {
          // A broken hook must not break the request.
        }
      }
      return fetchImpl(draft.url, {
        method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
        headers: draft.headers,
        ...(init.body !== undefined ? { body: init.body as BodyInit } : {}),
      });
    },
    addRequestHook(hook) {
      requestHooks.add(hook);
      return () => requestHooks.delete(hook);
    },
    addResponseHook(hook) {
      responseHooks.add(hook);
      return () => responseHooks.delete(hook);
    },
    pending() {
      return [...live.keys()];
    },
  };
}
