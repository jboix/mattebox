import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { initialState } from '../../../src/kernel/reducer.js';
import cmcd from '../../../src/stages/cmcd/index.js';
import codecProbe from '../../../src/stages/codec-probe/index.js';
import mp4Box from '../../../src/stages/mp4-box/index.js';
import { parseThumbnailTrack } from '../../../src/stages/thumbnails/index.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type {
  StageContext,
  TransformStep,
  TransportRequestDraftView,
  TypeProbe,
} from '../../../src/types/stage.js';

function segment(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../fixtures/segments/${name}`, import.meta.url))),
  );
}

/** A StageContext that records namespaces, transforms, hooks, and events. */
function fakeContext(overrides: Partial<{ state: KernelState; element: unknown }> = {}) {
  const namespaces: Record<string, unknown> = {};
  const transforms: TransformStep[] = [];
  const hooks: Array<(req: TransportRequestDraftView) => void> = [];
  const events: Array<{ event: string; payload: unknown }> = [];
  const probes: TypeProbe[] = [];
  const ctx = {
    element: overrides.element ?? {},
    registerTypeProbe: (probe: TypeProbe) => probes.push(probe),
    registerNamespace: (name: string, api: object) => {
      namespaces[name] = api;
    },
    registerTransform: (step: TransformStep) => transforms.push(step),
    addRequestHook: (hook: (req: TransportRequestDraftView) => void) => {
      hooks.push(hook);
      return () => undefined;
    },
    getState: () => overrides.state ?? initialState(),
    emit: (event: string, payload: unknown) => events.push({ event, payload }),
  } as unknown as StageContext;
  return { ctx, namespaces, transforms, hooks, events, probes };
}

const videoMeta = {
  trackId: 'sb:video',
  renditionId: 'v',
  contentType: 'video' as const,
  seq: -1,
  start: 0,
  duration: 0,
  isInit: true,
};

describe('codec-probe stage', () => {
  it('derives the codec string from a real init segment and publishes it', () => {
    const { ctx, namespaces, transforms, events } = fakeContext();
    codecProbe().install(ctx);
    const step = transforms[0] as TransformStep;
    const out = step.transform(segment('init-v-base.mp4'), videoMeta);
    // The bytes pass through untouched; the codec is reported, not rewritten.
    expect(out).toBeInstanceOf(Uint8Array);
    const api = namespaces.codecProbe as { detected: readonly string[]; mimeType: string | null };
    expect(api.detected).toContain('avc1.42c01e');
    expect(api.mimeType).toContain('avc1.42c01e');
    expect(events[0]?.event).toBe('codecprobe:detected');
  });

  it('registers the type probe: an init yields a full SourceBuffer type, a media segment null', () => {
    const { ctx, probes } = fakeContext();
    codecProbe().install(ctx);
    expect(probes).toHaveLength(1);
    const probe = probes[0] as TypeProbe;
    expect(probe(segment('init-v-base.mp4'))).toMatch(/^video\/mp4; codecs="avc1\.42c01e/);
    expect(probe(new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66]))).toBeNull();
  });

  it('ignores a media segment, which carries no moov', () => {
    const { ctx, transforms, events } = fakeContext();
    codecProbe().install(ctx);
    const step = transforms[0] as TransformStep;
    // A moof-only buffer: no codec to derive.
    step.transform(new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66]), videoMeta);
    expect(events).toHaveLength(0);
  });
});

describe('mp4-box stage', () => {
  it('exposes the walker on the facade', () => {
    const { ctx, namespaces } = fakeContext();
    mp4Box().install(ctx);
    const api = namespaces.mp4box as Record<string, unknown>;
    expect(typeof api.walkBoxes).toBe('function');
    expect(typeof api.findBox).toBe('function');
    expect(typeof api.parseTfdt).toBe('function');
  });
});

describe('cmcd stage', () => {
  it('appends a CMCD query argument built from playback state', () => {
    const state = initialState();
    const stateWithStats: KernelState = {
      ...state,
      stats: { ...state.stats, throughputEwma: 4_000_000 },
    };
    const element = {
      buffered: { length: 1, start: () => 0, end: () => 8 },
      currentTime: 2,
    };
    const { ctx, hooks } = fakeContext({ state: stateWithStats, element });
    cmcd({ contentId: 'demo', sessionId: 'abc' }).install(ctx);
    const draft: TransportRequestDraftView = {
      url: 'https://cdn.example/seg-1.m4s',
      headers: {},
      timeoutMs: null,
      token: 't',
      attempt: 0,
    };
    hooks[0]?.(draft);
    expect(draft.url).toContain('CMCD=');
    const value = decodeURIComponent(draft.url.split('CMCD=')[1] as string);
    expect(value).toContain('sid="abc"');
    expect(value).toContain('cid="demo"');
    expect(value).toContain('ot=av');
    // 4 Mbps measured, rounded to 100 kbps; 6 s of buffer ahead in ms.
    expect(value).toContain('mtp=4000');
    expect(value).toContain('bl=6000');
  });

  it('can send CMCD as a header instead', () => {
    const { ctx, hooks } = fakeContext({
      element: { buffered: { length: 0, start: () => 0, end: () => 0 }, currentTime: 0 },
    });
    cmcd({ mode: 'header', sessionId: 'x' }).install(ctx);
    const draft: TransportRequestDraftView = {
      url: 'https://cdn.example/media.m3u8',
      headers: {},
      timeoutMs: null,
      token: 't',
      attempt: 0,
    };
    hooks[0]?.(draft);
    expect(draft.url).not.toContain('CMCD=');
    expect(draft.headers['CMCD-Request']).toContain('ot=m'); // a manifest URL
  });
});

describe('thumbnails parsing', () => {
  it('parses a WebVTT sprite track into located tiles', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:10.000',
      'sprite.jpg#xywh=0,0,160,90',
      '',
      '00:00:10.000 --> 00:00:20.000',
      'sprite.jpg#xywh=160,0,160,90',
    ].join('\n');
    const tiles = parseThumbnailTrack(vtt, 'https://cdn.example/thumbs/track.vtt');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]?.url).toBe('https://cdn.example/thumbs/sprite.jpg');
    expect(tiles[1]).toMatchObject({ start: 10, end: 20, x: 160, y: 0, width: 160, height: 90 });
  });
});
