import { describe, expect, it, vi } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import {
  keySystemHandlers,
  normalizeSystemId,
  registerKeySystem,
} from '../../../src/stages/drm-shared.js';
import { unwrapPlayReadyResponse } from '../../../src/stages/eme-cenc/index.js';
import emeCore from '../../../src/stages/eme-core/index.js';
import {
  buildSpcRequest,
  contentIdFromSkd,
  parseCkcResponse,
} from '../../../src/stages/eme-fairplay/index.js';
import type { Presentation } from '../../../src/types/ir.js';
import type { StageContext } from '../../../src/types/stage.js';

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe('drm-shared registry', () => {
  it('normalizes scheme ids and system ids to bare lowercase uuids', () => {
    expect(normalizeSystemId('urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED')).toBe(
      'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
    );
    expect(normalizeSystemId('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed')).toBe(
      'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
    );
    expect(normalizeSystemId(null)).toBeNull();
    expect(normalizeSystemId('not-a-uuid')).toBeNull();
  });

  it('a repeat registration replaces by key system', () => {
    registerKeySystem({
      keySystem: 'test.system',
      systemIds: ['a'],
      initDataTypes: ['cenc'],
      buildLicenseRequest: (m) => m,
      parseLicenseResponse: (r) => r,
    });
    const before = keySystemHandlers().filter((h) => h.keySystem === 'test.system').length;
    registerKeySystem({
      keySystem: 'test.system',
      systemIds: ['b'],
      initDataTypes: ['cenc'],
      buildLicenseRequest: (m) => m,
      parseLicenseResponse: (r) => r,
    });
    const after = keySystemHandlers().filter((h) => h.keySystem === 'test.system');
    expect(before).toBe(1);
    expect(after).toHaveLength(1);
    expect(after[0]?.systemIds).toEqual(['b']);
  });
});

describe('eme-cenc shaping', () => {
  it('a widevine handler passes the message and response through', async () => {
    const { default: emeCenc } = await import('../../../src/stages/eme-cenc/index.js');
    emeCenc().install({} as never);
    const widevine = keySystemHandlers().find((h) => h.keySystem === 'com.widevine.alpha');
    expect(widevine?.systemIds).toEqual(['edef8ba9-79d6-4ace-a3c8-27dcd51d21ed']);
    const message = bytes('challenge');
    expect(new Uint8Array(widevine?.buildLicenseRequest(message) as Uint8Array)).toEqual(
      new Uint8Array(message),
    );
  });

  it('the playready handler unwraps a SOAP license and sets the SOAP headers', () => {
    const license = 'PLAYREADY-LICENSE-BYTES';
    const soap = `<soap:Envelope><License>${btoa(license)}</License></soap:Envelope>`;
    const unwrapped = unwrapPlayReadyResponse(bytes(soap));
    expect(new TextDecoder().decode(unwrapped)).toBe(license);
    // A non-SOAP body passes through untouched.
    const raw = bytes('raw-license');
    expect(new Uint8Array(unwrapPlayReadyResponse(raw) as ArrayBuffer)).toEqual(
      new Uint8Array(raw),
    );
    const playready = keySystemHandlers().find((h) => h.keySystem === 'com.microsoft.playready');
    expect(playready?.licenseHeaders?.['Content-Type']).toContain('text/xml');
  });
});

describe('eme-fairplay shaping', () => {
  it('extracts the content id from an skd uri', () => {
    expect(contentIdFromSkd(bytes('skd://twelve/34567890'))).toBe('twelve/34567890');
    expect(contentIdFromSkd(bytes('bare-content-id'))).toBe('bare-content-id');
  });

  it('builds the spc form body and parses a ckc response', () => {
    const spc = buildSpcRequest(bytes('SPC-BYTES'));
    const spcText = new TextDecoder().decode(spc);
    expect(spcText.startsWith('spc=')).toBe(true);
    expect(decodeURIComponent(spcText.slice(4))).toBe(btoa('SPC-BYTES'));

    const ckc = 'CKC-KEY-BYTES';
    const parsed = parseCkcResponse(bytes(`ckc=${btoa(ckc)}`));
    expect(new TextDecoder().decode(parsed)).toBe(ckc);
    // A bare base64 body works too.
    expect(new TextDecoder().decode(parseCkcResponse(bytes(btoa(ckc))))).toBe(ckc);
  });
});

describe('eme-fairplay license body', () => {
  async function handler(options?: { licenseBody?: 'binary' | 'form' }) {
    const { default: emeFairplay } = await import('../../../src/stages/eme-fairplay/index.js');
    emeFairplay(options).install({} as never);
    return keySystemHandlers().find((h) => h.keySystem === 'com.apple.fps');
  }

  it('sends the SPC bytes as they are by default', async () => {
    const fps = await handler();
    const spc = bytes('SPC-BYTES');
    expect(fps?.licenseHeaders).toEqual({ 'Content-Type': 'application/octet-stream' });
    expect(new Uint8Array(fps?.buildLicenseRequest(spc) as ArrayBuffer)).toEqual(
      new Uint8Array(spc),
    );
  });

  it('sends an spc= form field when asked', async () => {
    const fps = await handler({ licenseBody: 'form' });
    expect(fps?.licenseHeaders).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const body = new TextDecoder().decode(fps?.buildLicenseRequest(bytes('SPC-BYTES')));
    expect(body).toBe(`spc=${encodeURIComponent(btoa('SPC-BYTES'))}`);
  });
});

describe('the manifest DRM route', () => {
  const reduce = createReducer();

  function protectedPresentation(): Presentation {
    return {
      id: 'p',
      isLive: false,
      duration: 20,
      periods: [
        {
          id: 'p0',
          start: 0,
          tracks: [
            {
              id: 'v',
              contentType: 'video',
              mimeType: 'video/mp4',
              protection: {
                schemes: [
                  {
                    systemId: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
                    scheme: 'cenc',
                    keyId: '9eb4050de44b4802932e27d75083e266',
                    licenseUrl: null,
                    initData: bytes('pssh'),
                    initDataType: 'cenc',
                  },
                ],
              },
              renditions: [
                {
                  id: 'v-1',
                  bitrate: 500_000,
                  codecs: 'avc1.42c01e',
                  mimeType: 'video/mp4',
                  segments: [{ seq: 0, start: 0, duration: 4, url: 'u' }],
                },
              ],
            },
          ],
        },
      ],
      couplings: [],
    };
  }

  it('MANIFEST_LOADED emits the protection schemes for eme-core, without DRM state in the reducer', () => {
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: 'https://cdn.example/m.mpd' });
    const [next, fx] = reduce(state, {
      type: 'MANIFEST_LOADED',
      presentation: protectedPresentation(),
    });
    const protectionEvent = fx.find(
      (e) => e.kind === 'emit' && e.event === 'presentation:protection',
    );
    expect(protectionEvent).toBeDefined();
    const schemes = (protectionEvent as unknown as { payload: unknown[] }).payload;
    expect(schemes).toHaveLength(1);
    // The reducer carries no DRM state; DRM is entirely eme-core's edge.
    expect('drm' in next).toBe(false);
  });

  it('an unprotected manifest emits no protection event', () => {
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: 'https://cdn.example/m.m3u8' });
    const clear = protectedPresentation();
    const unprotected: Presentation = {
      ...clear,
      periods: [
        {
          ...(clear.periods[0] as Presentation['periods'][number]),
          tracks: [{ ...(clear.periods[0]?.tracks[0] as object), protection: null } as never],
        },
      ],
    };
    const [, fx] = reduce(state, { type: 'MANIFEST_LOADED', presentation: unprotected });
    expect(fx.some((e) => e.kind === 'emit' && e.event === 'presentation:protection')).toBe(false);
  });
});

describe('eme-core certificate fetch', () => {
  it('an HTTP error is not handed to the CDM and names itself in the failure', async () => {
    const SYSTEM_ID = '94ce86fb-07ff-4f43-adb8-93d2fa968ca2';
    registerKeySystem({
      keySystem: 'com.example.certificate-test',
      systemIds: [SYSTEM_ID],
      initDataTypes: ['sinf'],
      buildLicenseRequest: (m) => m,
      parseLicenseResponse: (r) => r,
      fairplay: { certificateUrl: 'https://cdn.example/cert.der', contentId: () => '' },
    });
    const setServerCertificate = vi.fn(async () => true);
    const original = navigator.requestMediaKeySystemAccess;
    Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
      configurable: true,
      value: async (keySystem: string) => {
        if (keySystem !== 'com.example.certificate-test') throw new Error('unsupported');
        return { createMediaKeys: async () => ({ setServerCertificate }) };
      },
    });
    try {
      const errors: unknown[] = [];
      let onProtection: ((payload: unknown) => void) | null = null;
      emeCore().install({
        element: { addEventListener: () => undefined, removeEventListener: () => undefined },
        registerNamespace: () => undefined,
        request: async () => new Response('not found', { status: 404 }),
        emit: (event: string, payload: unknown) => {
          if (event === 'error') errors.push(payload);
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
          initData: null,
          initDataType: null,
        },
      ]);
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(setServerCertificate).not.toHaveBeenCalled();
      expect(errors[0]).toMatchObject({
        code: 'DRM_KEY_SYSTEM_UNAVAILABLE',
        context: { message: expect.stringContaining('HTTP 404') },
      });
    } finally {
      Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
        configurable: true,
        value: original,
      });
    }
  });
});

describe('eme-core certificate URL', () => {
  it('fetches the certificate eme-core was given when the FairPlay stage has none', async () => {
    const SYSTEM_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
    registerKeySystem({
      keySystem: 'com.example.certificate-option',
      systemIds: [SYSTEM_ID],
      initDataTypes: ['skd'],
      buildLicenseRequest: (m) => m,
      parseLicenseResponse: (r) => r,
      fairplay: { contentId: () => '' },
    });
    const certificates: unknown[] = [];
    const original = navigator.requestMediaKeySystemAccess;
    Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
      configurable: true,
      value: async (keySystem: string) => {
        if (keySystem !== 'com.example.certificate-option') throw new Error('unsupported');
        return {
          createMediaKeys: async () => ({
            setServerCertificate: async (cert: ArrayBuffer) => {
              certificates.push(new TextDecoder().decode(cert));
              return true;
            },
          }),
        };
      },
    });
    try {
      const requested: string[] = [];
      let drm: { setCertificateUrl(url: string): void } | null = null;
      let onProtection: ((payload: unknown) => void) | null = null;
      emeCore({ certificateUrl: 'https://cdn.example/old.der' }).install({
        element: {
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          setMediaKeys: async () => undefined,
        },
        registerNamespace: (_name: string, api: unknown) => {
          drm = api as typeof drm;
        },
        request: async (url: string) => {
          requested.push(url);
          return new Response('CERT');
        },
        emit: () => undefined,
        on: (event: string, fn: (payload: unknown) => void) => {
          if (event === 'presentation:protection') onProtection = fn;
          return () => undefined;
        },
      } as unknown as StageContext);
      // The page sets the URL after the engine exists, as the player's attribute does.
      (drm as unknown as { setCertificateUrl(url: string): void }).setCertificateUrl(
        'https://cdn.example/cert.der',
      );
      (onProtection as unknown as (payload: unknown) => void)([
        {
          systemId: SYSTEM_ID,
          scheme: null,
          keyId: null,
          licenseUrl: null,
          initData: null,
          initDataType: null,
        },
      ]);
      await vi.waitFor(() => expect(certificates).toEqual(['CERT']));
      expect(requested).toEqual(['https://cdn.example/cert.der']);
    } finally {
      Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
        configurable: true,
        value: original,
      });
    }
  });
});

describe('eme-core license renewal', () => {
  const SYSTEM_ID = '5e629af5-38da-4063-8977-97ffbd9902d4';
  const KEY_ID = new Uint8Array(16).fill(7).buffer;

  /** A session that answers each license with the next queued key status. */
  class FakeSession extends EventTarget {
    readonly keyStatuses = new Map<ArrayBuffer, string>();
    readonly updates: unknown[] = [];
    closed = false;
    constructor(private readonly onUpdate: () => string) {
      super();
    }
    async generateRequest(): Promise<void> {
      this.message('license-request');
    }
    async update(license: unknown): Promise<void> {
      this.updates.push(license);
      this.setStatus(this.onUpdate());
    }
    async close(): Promise<void> {
      this.closed = true;
    }
    message(messageType: string): void {
      const event = Object.assign(new Event('message'), {
        messageType,
        message: bytes(messageType),
      });
      this.dispatchEvent(event);
    }
    setStatus(status: string): void {
      this.keyStatuses.set(KEY_ID, status);
      this.dispatchEvent(new Event('keystatuseschange'));
    }
  }

  async function setup(licenseStatuses: string[]) {
    registerKeySystem({
      keySystem: 'com.example.renewal-test',
      systemIds: [SYSTEM_ID],
      initDataTypes: ['cenc'],
      buildLicenseRequest: (m) => m,
      parseLicenseResponse: (r) => r,
    });
    const sessions: FakeSession[] = [];
    const posts: string[] = [];
    const errors: Array<{ code?: string }> = [];
    const renewals: unknown[] = [];
    const element = Object.assign(new EventTarget(), {
      paused: false,
      setMediaKeys: async () => undefined,
    });
    const original = navigator.requestMediaKeySystemAccess;
    Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
      configurable: true,
      value: async (keySystem: string) => {
        if (keySystem !== 'com.example.renewal-test') throw new Error('unsupported');
        return {
          createMediaKeys: async () => ({
            createSession: () => {
              const session = new FakeSession(() => licenseStatuses.shift() ?? 'usable');
              sessions.push(session);
              return session;
            },
          }),
        };
      },
    });
    let onProtection: ((payload: unknown) => void) | null = null;
    const dispose = emeCore({ licenseUrl: 'https://license.example/' }).install({
      element,
      registerNamespace: () => undefined,
      request: async (_url: string, init: { body?: ArrayBuffer | Uint8Array | string }) => {
        posts.push(new TextDecoder().decode(init.body as ArrayBuffer));
        return new Response(new Uint8Array([1]));
      },
      emit: (event: string, payload: unknown) => {
        if (event === 'error') errors.push(payload as { code?: string });
        if (event === 'drm:renewing') renewals.push(payload);
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
        initData: bytes('pssh'),
        initDataType: 'cenc',
      },
    ]);
    await vi.waitFor(() => expect(sessions[0]?.updates).toHaveLength(1));
    const restore = () => {
      if (typeof dispose === 'function') dispose();
      Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
        configurable: true,
        value: original,
      });
    };
    return { sessions, posts, errors, renewals, element, restore };
  }

  it('an expired key during playback opens a new session and closes the old one', async () => {
    const t = await setup(['usable', 'usable']);
    try {
      (t.sessions[0] as FakeSession).setStatus('expired');
      await vi.waitFor(() => expect(t.sessions[1]?.updates).toHaveLength(1));
      expect(t.renewals).toHaveLength(1);
      expect(t.posts).toEqual(['license-request', 'license-request']);
      expect(t.sessions[0]?.closed).toBe(true);
      expect(t.sessions[1]?.closed).toBe(false);
      expect(t.errors).toEqual([]);
    } finally {
      t.restore();
    }
  });

  it('a key that expires while paused renews on the next play', async () => {
    const t = await setup(['usable', 'usable']);
    try {
      t.element.paused = true;
      (t.sessions[0] as FakeSession).setStatus('expired');
      await Promise.resolve();
      expect(t.sessions).toHaveLength(1);
      expect(t.posts).toHaveLength(1);
      t.element.paused = false;
      t.element.dispatchEvent(new Event('play'));
      await vi.waitFor(() => expect(t.sessions[1]?.updates).toHaveLength(1));
      expect(t.sessions[0]?.closed).toBe(true);
    } finally {
      t.restore();
    }
  });

  it('a license that arrives expired reports DRM_KEY_EXPIRED instead of renewing again', async () => {
    const t = await setup(['usable', 'expired']);
    try {
      (t.sessions[0] as FakeSession).setStatus('expired');
      await vi.waitFor(() => expect(t.errors).toHaveLength(1));
      expect(t.errors[0]).toMatchObject({ code: 'DRM_KEY_EXPIRED', fatal: false });
      expect(t.sessions).toHaveLength(2);
      // The old session stays open: nothing usable replaced it.
      expect(t.sessions[0]?.closed).toBe(false);
    } finally {
      t.restore();
    }
  });

  it('a renewal message from the CDM is posted on the same session', async () => {
    const t = await setup(['usable', 'usable']);
    try {
      (t.sessions[0] as FakeSession).message('license-renewal');
      await vi.waitFor(() => expect(t.sessions[0]?.updates).toHaveLength(2));
      expect(t.posts).toEqual(['license-request', 'license-renewal']);
      expect(t.sessions).toHaveLength(1);
    } finally {
      t.restore();
    }
  });

  it('dispose closes every open session, a renewal included', async () => {
    const t = await setup(['usable', 'usable']);
    (t.sessions[0] as FakeSession).setStatus('expired');
    await vi.waitFor(() => expect(t.sessions[1]?.updates).toHaveLength(1));
    t.restore();
    expect(t.sessions.every((s) => s.closed)).toBe(true);
  });
});
