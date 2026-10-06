import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachEme } from '../../src/eme/index.js';
import { registerKeySystem } from '../../src/stages/drm-shared.js';
import type { Stage } from '../../src/types/stage.js';

const KID = 'nrQFDeRLSAKTLifXUIPiZg';
const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

/** A session that sends one license request and turns usable on the license. */
class FakeSession extends EventTarget {
  readonly keyStatuses = new Map<ArrayBuffer, string>();
  readonly updates: string[] = [];
  closed = false;
  async generateRequest(_type: string, initData: ArrayBuffer): Promise<void> {
    this.dispatchEvent(Object.assign(new Event('message'), { message: initData }));
  }
  async update(license: BufferSource): Promise<void> {
    this.updates.push(new TextDecoder().decode(license));
    this.keyStatuses.set(new Uint8Array(16).fill(1).buffer, 'usable');
    this.dispatchEvent(new Event('keystatuseschange'));
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function fakeElement() {
  return Object.assign(new EventTarget(), {
    paused: true,
    mediaKeys: null as unknown,
    async setMediaKeys(keys: unknown) {
      this.mediaKeys = keys;
    },
  });
}

/** The `encrypted` event a browser fires for keyids content. */
function encrypted(): Event {
  return Object.assign(new Event('encrypted'), {
    initDataType: 'keyids',
    initData: encode(JSON.stringify({ kids: [KID] })),
  });
}

let sessions: FakeSession[];
let systems: string[];
let original: typeof navigator.requestMediaKeySystemAccess;

beforeEach(() => {
  sessions = [];
  systems = [];
  original = navigator.requestMediaKeySystemAccess;
  Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
    configurable: true,
    value: async (keySystem: string) => {
      systems.push(keySystem);
      return {
        createMediaKeys: async () => ({
          setServerCertificate: async () => true,
          createSession: () => {
            const session = new FakeSession();
            sessions.push(session);
            return session;
          },
        }),
      };
    },
  });
});

afterEach(() => {
  Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
    configurable: true,
    value: original,
  });
  vi.unstubAllGlobals();
});

describe('attachEme', () => {
  it('licenses ClearKey content from the encrypted event, without an engine', async () => {
    const element = fakeElement();
    const drm = attachEme(element as unknown as HTMLMediaElement, {
      clearKeys: { [KID]: 'FmY0xnWCPCNaSpRG-tUuTQ' },
    });
    const statuses: unknown[] = [];
    drm.on('drm:keystatus', (payload) => statuses.push(payload));
    element.dispatchEvent(encrypted());
    await vi.waitFor(() => expect(drm.drm.sessions).toHaveLength(1));
    expect(systems).toEqual(['org.w3.clearkey']);
    expect(drm.drm.keySystem).toBe('org.w3.clearkey');
    expect(drm.drm.sessions[0]?.status).toBe('usable');
    expect(statuses).toHaveLength(1);
    expect(JSON.parse(sessions[0]?.updates[0] ?? '')).toMatchObject({
      keys: [{ kid: KID, k: 'FmY0xnWCPCNaSpRG-tUuTQ' }],
    });
    expect(element.mediaKeys).not.toBeNull();
  });

  it('installs the key systems it is given and sends their licenses through the request hook', async () => {
    const posts: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      posts.push({ url, headers: init.headers as Record<string, string> });
      return new Response('license');
    });
    const keySystem: Stage = {
      name: 'test-key-system',
      install() {
        registerKeySystem({
          keySystem: 'com.example.attach-test',
          systemIds: [],
          initDataTypes: ['keyids'],
          licenseHeaders: { 'Content-Type': 'application/octet-stream' },
          buildLicenseRequest: (message) => message,
          parseLicenseResponse: (response) => response,
        });
      },
    };
    const element = fakeElement();
    const drm = attachEme(element as unknown as HTMLMediaElement, {
      keySystems: [keySystem],
      licenseUrl: 'https://license.example/',
      requestHook: (request) => {
        request.url += '?session=1';
        request.headers.Authorization = 'Bearer token';
      },
    });
    element.dispatchEvent(encrypted());
    await vi.waitFor(() => expect(sessions[0]?.updates).toEqual(['license']));
    expect(drm.drm.keySystem).toBe('com.example.attach-test');
    expect(posts).toEqual([
      {
        url: 'https://license.example/?session=1',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer token' },
      },
    ]);
  });

  it('reports DRM failures as error events', async () => {
    Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
      configurable: true,
      value: async () => {
        throw new Error('unsupported');
      },
    });
    const element = fakeElement();
    const drm = attachEme(element as unknown as HTMLMediaElement, { clearKeys: {} });
    const errors: unknown[] = [];
    drm.on('error', (payload) => errors.push(payload));
    element.dispatchEvent(encrypted());
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ category: 'drm', code: 'DRM_KEY_SYSTEM_UNAVAILABLE' });
  });

  it('detach closes the sessions, clears the MediaKeys, and stops listening', async () => {
    const element = fakeElement();
    const drm = attachEme(element as unknown as HTMLMediaElement, {
      clearKeys: { [KID]: 'FmY0xnWCPCNaSpRG-tUuTQ' },
    });
    const statuses: unknown[] = [];
    drm.on('drm:keystatus', (payload) => statuses.push(payload));
    element.dispatchEvent(encrypted());
    await vi.waitFor(() => expect(statuses).toHaveLength(1));
    drm.detach();
    await vi.waitFor(() => expect(element.mediaKeys).toBeNull());
    expect(sessions[0]?.closed).toBe(true);
    element.dispatchEvent(encrypted());
    await Promise.resolve();
    expect(sessions).toHaveLength(1);
    expect(statuses).toHaveLength(1);
  });
});
