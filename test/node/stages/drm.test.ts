import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import {
  keySystemHandlers,
  normalizeSystemId,
  registerKeySystem,
} from '../../../src/stages/drm-shared.js';
import { unwrapPlayReadyResponse } from '../../../src/stages/eme-cenc/index.js';
import {
  buildSpcRequest,
  contentIdFromSkd,
  parseCkcResponse,
} from '../../../src/stages/eme-fairplay/index.js';
import type { Presentation } from '../../../src/types/ir.js';

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
