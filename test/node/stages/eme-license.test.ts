import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerKeySystem } from '../../../src/stages/drm-shared.js';
import type { EmeOptions, LicenseContext } from '../../../src/stages/eme-core/index.js';
import emeCore from '../../../src/stages/eme-core/index.js';
import type { OneOffRequestInit, StageContext } from '../../../src/types/stage.js';

const SYSTEM_ID = '6a99532d-869f-4d75-9e8b-d5c2c1d4c4d5';
const KEY_SYSTEM = 'com.example.license-test';
const OTHER_SYSTEM = 'com.example.other-test';
const KEY_ID = new Uint8Array(16).fill(3).buffer;

const text = (bytes: ArrayBuffer | Uint8Array | string | undefined): string =>
  typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);

/** A session that sends one license request and turns usable on any license. */
class FakeSession extends EventTarget {
  readonly sessionId = 'session-1';
  readonly keyStatuses = new Map<ArrayBuffer, string>();
  readonly updates: string[] = [];
  async generateRequest(): Promise<void> {
    this.dispatchEvent(
      Object.assign(new Event('message'), {
        messageType: 'license-request',
        message: new TextEncoder().encode('challenge').buffer,
      }),
    );
  }
  async update(license: ArrayBuffer | Uint8Array): Promise<void> {
    this.updates.push(text(license));
    this.keyStatuses.set(KEY_ID, 'usable');
    this.dispatchEvent(new Event('keystatuseschange'));
  }
  async close(): Promise<void> {}
}

/**
 * A license server that wants `Authorization: Bearer <token>` with the
 * current token. `rotate()` issues a new one and voids the old, as a token
 * service does when a token expires.
 */
function licenseServer() {
  let current = 1;
  const server = {
    get token(): string {
      return `token-${current}`;
    },
    rotate(): void {
      current += 1;
    },
    /** Statuses to answer before the real answer, in order; 0 throws a network error. */
    script: [] as number[],
    calls: [] as Array<{ url: string; init: OneOffRequestInit }>,
    async request(url: string, init: OneOffRequestInit): Promise<Response> {
      server.calls.push({ url, init });
      const scripted = server.script.shift();
      if (scripted === 0) throw new TypeError('Failed to fetch');
      if (scripted === -1) throw new DOMException('slow', 'TimeoutError');
      if (scripted !== undefined) return new Response('', { status: scripted });
      if (init.headers?.Authorization !== `Bearer ${server.token}`) {
        return new Response('', { status: 401 });
      }
      return new Response(`license for ${text(init.body)}`);
    },
  };
  return server;
}

interface Setup {
  readonly sessions: FakeSession[];
  readonly errors: Array<{ code?: string; context?: { message: string } }>;
  readonly certificates: Array<{ keySystem: string; certificate: string }>;
  readonly tried: string[];
  readonly dispose: () => void;
}

const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  vi.useRealTimers();
});

function setup(
  options: EmeOptions,
  request: (url: string, init: OneOffRequestInit) => Promise<Response>,
  supported: readonly string[] = [KEY_SYSTEM, OTHER_SYSTEM],
): Setup {
  for (const keySystem of [KEY_SYSTEM, OTHER_SYSTEM]) {
    registerKeySystem({
      keySystem,
      systemIds: [SYSTEM_ID],
      initDataTypes: ['cenc'],
      buildLicenseRequest: (m) => m,
      parseLicenseResponse: (r) => r,
    });
  }
  const sessions: FakeSession[] = [];
  const errors: Setup['errors'] = [];
  const certificates: Setup['certificates'] = [];
  const tried: string[] = [];
  const original = navigator.requestMediaKeySystemAccess;
  Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
    configurable: true,
    value: async (keySystem: string) => {
      tried.push(keySystem);
      if (!supported.includes(keySystem)) throw new Error(`${keySystem} unsupported`);
      return {
        createMediaKeys: async () => ({
          setServerCertificate: async (certificate: ArrayBuffer | Uint8Array) => {
            certificates.push({ keySystem, certificate: text(certificate) });
            return true;
          },
          createSession: () => {
            const session = new FakeSession();
            sessions.push(session);
            return session;
          },
        }),
      };
    },
  });
  restore.push(() =>
    Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
      configurable: true,
      value: original,
    }),
  );
  let onProtection: ((payload: unknown) => void) | null = null;
  const teardown = emeCore(options).install({
    element: Object.assign(new EventTarget(), {
      paused: false,
      setMediaKeys: async () => undefined,
    }),
    registerNamespace: () => undefined,
    request,
    emit: (event: string, payload: unknown) => {
      if (event === 'error') errors.push(payload as Setup['errors'][number]);
    },
    on: (event: string, fn: (payload: unknown) => void) => {
      if (event === 'presentation:protection') onProtection = fn;
      return () => undefined;
    },
  } as unknown as StageContext);
  (onProtection as unknown as (payload: unknown) => void)([
    {
      systemId: SYSTEM_ID,
      scheme: null,
      keyId: null,
      licenseUrl: null,
      initData: new TextEncoder().encode('pssh').buffer,
      initDataType: 'cenc',
    },
  ]);
  return {
    sessions,
    errors,
    certificates,
    tried,
    dispose: () => {
      if (typeof teardown === 'function') teardown();
    },
  };
}

const NO_DELAY = { delayMs: 0 };

describe('eme-core license request', () => {
  it('an async request filter adds the current token, and an async response filter shapes the license', async () => {
    const server = licenseServer();
    const t = setup(
      {
        licenseUrl: 'https://license.example/',
        requestFilter: async (body, keySystem, request) => {
          request.headers.Authorization = `Bearer ${server.token}`;
          request.url += `?system=${keySystem}`;
          return body;
        },
        responseFilter: async (body, _keySystem, response) =>
          new TextEncoder().encode(`${text(body)} (${response.status})`),
      },
      (url, init) => server.request(url, init),
    );
    await vi.waitFor(() => expect(t.sessions[0]?.updates).toEqual(['license for challenge (200)']));
    expect(server.calls[0]?.url).toBe(`https://license.example/?system=${KEY_SYSTEM}`);
    expect(server.calls[0]?.init).toMatchObject({ method: 'POST', timeoutMs: 20_000 });
    expect(t.errors).toEqual([]);
  });

  it('a synchronous request filter keeps working', async () => {
    const server = licenseServer();
    const t = setup(
      {
        licenseUrl: 'https://license.example/',
        requestFilter: (body) => new Uint8Array([...body, 33]),
      },
      async (url, init) =>
        server.request(url, {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${server.token}` },
        }),
    );
    await vi.waitFor(() => expect(t.sessions[0]?.updates).toEqual(['license for challenge!']));
  });

  it('refreshes the token once on a 401 and sends the request again', async () => {
    const server = licenseServer();
    server.rotate();
    let token = 'token-1';
    const unauthorized = vi.fn(async () => {
      token = server.token;
    });
    const attempts: number[] = [];
    const t = setup(
      {
        licenseUrl: 'https://license.example/',
        requestFilter: (body, _keySystem, request) => {
          attempts.push(request.attempt);
          request.headers.Authorization = `Bearer ${token}`;
          return body;
        },
        onUnauthorized: unauthorized,
      },
      (url, init) => server.request(url, init),
    );
    await vi.waitFor(() => expect(t.sessions[0]?.updates).toEqual(['license for challenge']));
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(unauthorized).toHaveBeenCalledWith({ keySystem: KEY_SYSTEM, status: 401 });
    expect(attempts).toEqual([1, 2]);
  });

  it('a second 401 after the refresh fails without another refresh', async () => {
    const server = licenseServer();
    const unauthorized = vi.fn();
    const t = setup(
      { licenseUrl: 'https://license.example/', onUnauthorized: unauthorized },
      (url, init) => server.request(url, init),
    );
    await vi.waitFor(() => expect(t.errors).toHaveLength(1));
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(server.calls).toHaveLength(2);
    expect(t.errors[0]).toMatchObject({
      code: 'DRM_LICENSE_FAILED',
      context: { message: 'status 401' },
    });
  });

  it('without onUnauthorized a 401 fails at once', async () => {
    const server = licenseServer();
    const t = setup({ licenseUrl: 'https://license.example/' }, (url, init) =>
      server.request(url, init),
    );
    await vi.waitFor(() => expect(t.errors).toHaveLength(1));
    expect(server.calls).toHaveLength(1);
  });

  it('retries a 5xx and a network error, and sends the same body again', async () => {
    const server = licenseServer();
    server.script = [503, 0];
    const t = setup(
      { licenseUrl: 'https://license.example/', licenseRetry: NO_DELAY },
      (url, init) =>
        server.request(url, {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${server.token}` },
        }),
    );
    await vi.waitFor(() => expect(t.sessions[0]?.updates).toEqual(['license for challenge']));
    expect(server.calls.map((c) => text(c.init.body))).toEqual([
      'challenge',
      'challenge',
      'challenge',
    ]);
    expect(t.errors).toEqual([]);
  });

  it('a 4xx other than 401 and 403 never retries', async () => {
    const server = licenseServer();
    server.script = [404];
    const t = setup(
      { licenseUrl: 'https://license.example/', licenseRetry: NO_DELAY },
      (url, init) => server.request(url, init),
    );
    await vi.waitFor(() => expect(t.errors).toHaveLength(1));
    expect(server.calls).toHaveLength(1);
  });

  it('gives up after the error retries, with the last reason', async () => {
    const server = licenseServer();
    server.script = [500, 500, 500];
    const t = setup(
      { licenseUrl: 'https://license.example/', licenseRetry: { delayMs: 0, errorRetries: 2 } },
      (url, init) => server.request(url, init),
    );
    await vi.waitFor(() => expect(t.errors).toHaveLength(1));
    expect(server.calls).toHaveLength(3);
    expect(t.errors[0]).toMatchObject({ context: { message: 'status 500' } });
  });

  it('a timeout retries once by default', async () => {
    const server = licenseServer();
    server.script = [-1, -1];
    const t = setup(
      { licenseUrl: 'https://license.example/', licenseRetry: NO_DELAY },
      (url, init) => server.request(url, init),
    );
    await vi.waitFor(() => expect(t.errors).toHaveLength(1));
    expect(server.calls).toHaveLength(2);
    expect(t.errors[0]?.context?.message).toContain('TimeoutError');
  });

  it('waits the delay before a retry, doubled each time with exponential backoff', async () => {
    vi.useFakeTimers();
    const server = licenseServer();
    server.script = [503, 503, 503];
    setup(
      {
        licenseUrl: 'https://license.example/',
        licenseRetry: { delayMs: 100, maxDelayMs: 300, backoff: 'exponential' },
      },
      (url, init) => server.request(url, init),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(server.calls).toHaveLength(3);
    // 400 ms, capped at 300.
    await vi.advanceTimersByTimeAsync(300);
    expect(server.calls).toHaveLength(4);
  });

  it('a teardown during the retry delay reports nothing and sends nothing more', async () => {
    vi.useFakeTimers();
    const server = licenseServer();
    server.script = [503];
    const t = setup({ licenseUrl: 'https://license.example/' }, (url, init) =>
      server.request(url, init),
    );
    await vi.advanceTimersByTimeAsync(0);
    t.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.calls).toHaveLength(1);
    expect(t.errors).toEqual([]);
  });

  it('the request carries a signal that the teardown aborts', async () => {
    let signal: AbortSignal | undefined;
    const t = setup({ licenseUrl: 'https://license.example/' }, (_url, init) => {
      signal = init.signal;
      return new Promise(() => undefined);
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    t.dispose();
    expect(signal?.aborted).toBe(true);
  });
});

describe('eme-core getLicense', () => {
  it('replaces the built-in request and gets the message with its context', async () => {
    const contexts: LicenseContext[] = [];
    const request = vi.fn();
    const t = setup(
      {
        getLicense: async (message, context) => {
          contexts.push(context);
          return new TextEncoder().encode(`custom ${text(message)}`);
        },
      },
      request,
    );
    await vi.waitFor(() => expect(t.sessions[0]?.updates).toEqual(['custom challenge']));
    expect(request).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      keySystem: KEY_SYSTEM,
      sessionId: 'session-1',
      initDataType: 'cenc',
      attempt: 1,
    });
    expect(text(contexts[0]?.initData)).toBe('pssh');
  });

  it('retries a rejection, and a 401 rejection refreshes the token', async () => {
    const outcomes: Array<unknown> = [new Error('offline'), { status: 401 }];
    const unauthorized = vi.fn();
    const attempts: number[] = [];
    const t = setup(
      {
        licenseRetry: NO_DELAY,
        onUnauthorized: unauthorized,
        getLicense: async (_message, context) => {
          attempts.push(context.attempt);
          const outcome = outcomes.shift();
          if (outcome !== undefined) throw outcome;
          return new TextEncoder().encode('license');
        },
      },
      vi.fn(),
    );
    await vi.waitFor(() => expect(t.sessions[0]?.updates).toEqual(['license']));
    expect(attempts).toEqual([1, 2, 3]);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('a 4xx rejection fails without a retry', async () => {
    const getLicense = vi.fn(async () => {
      throw Object.assign(new Error('forbidden region'), { status: 451 });
    });
    const t = setup({ getLicense, licenseRetry: NO_DELAY }, vi.fn());
    await vi.waitFor(() => expect(t.errors).toHaveLength(1));
    expect(getLicense).toHaveBeenCalledTimes(1);
    expect(t.errors[0]?.context?.message).toContain('forbidden region');
  });
});

describe('eme-core key systems', () => {
  const ok = async () => new Response('license');

  it('getCertificate sets a service certificate on any key system', async () => {
    const t = setup(
      {
        licenseUrl: 'https://license.example/',
        getCertificate: async (keySystem) => new TextEncoder().encode(`cert for ${keySystem}`),
      },
      ok,
    );
    await vi.waitFor(() => expect(t.sessions).toHaveLength(1));
    expect(t.certificates).toEqual([
      { keySystem: KEY_SYSTEM, certificate: `cert for ${KEY_SYSTEM}` },
    ]);
  });

  it('a failed certificate moves on to the next key system', async () => {
    const t = setup(
      {
        licenseUrl: 'https://license.example/',
        getCertificate: async (keySystem) => {
          if (keySystem === KEY_SYSTEM) throw new Error('no certificate');
          return null;
        },
      },
      ok,
    );
    await vi.waitFor(() => expect(t.sessions).toHaveLength(1));
    expect(t.tried).toEqual([KEY_SYSTEM, OTHER_SYSTEM]);
    expect(t.certificates).toEqual([]);
    expect(t.errors).toEqual([]);
  });

  it('tries the listed key systems first, in list order', async () => {
    const t = setup(
      { licenseUrl: 'https://license.example/', preferredKeySystems: [OTHER_SYSTEM] },
      ok,
      [KEY_SYSTEM],
    );
    await vi.waitFor(() => expect(t.sessions).toHaveLength(1));
    // An unlisted key system once sorted first, at index -1.
    expect(t.tried).toEqual([OTHER_SYSTEM, KEY_SYSTEM]);
  });
});
