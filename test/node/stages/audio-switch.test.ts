import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { canSwitchTo } from '../../../src/kernel/rendition-select.js';
import altAudio from '../../../src/stages/alt-audio/index.js';
import { createPolicy } from '../../../src/stages/codec-switch/index.js';
import type { Presentation, Rendition } from '../../../src/types/ir.js';
import type { KernelState, SliceReducer } from '../../../src/types/kernel.js';
import type { Effect, Message } from '../../../src/types/messages.js';
import type { Stage } from '../../../src/types/stage.js';

function compose(...stages: Stage[]) {
  const slices: Array<readonly [string, SliceReducer]> = [];
  for (const stage of stages) {
    stage.install({
      element: {} as HTMLMediaElement,
      registerSink: () => undefined,
      registerParser: () => undefined,
      registerTransform: () => undefined,
      registerNamespace: () => undefined,
      registerChooser: () => undefined,
      registerSwitchPolicy: () => undefined,
      registerTypeProbe: () => undefined,
      getState: () => initialState(),
      addRequestHook: () => () => undefined,
      request: async () => new Response(),
      reduce: (name, reducer) => slices.push([name, reducer as SliceReducer]),
      dispatch: () => undefined,
      emit: () => undefined,
      on: () => () => undefined,
    });
  }
  return createReducer(slices);
}

function settle(
  reduce: ReturnType<typeof createReducer>,
  state: KernelState,
  effects: readonly Effect[],
): { state: KernelState; effects: Effect[] } {
  let current = state;
  const all: Effect[] = [...effects];
  let frontier = effects;
  while (frontier.length > 0) {
    const next: Effect[] = [];
    for (const effect of frontier) {
      if (effect.kind !== 'schedule' || effect.delayMs !== 0) continue;
      const [reduced, produced] = reduce(current, effect.then);
      current = reduced;
      next.push(...produced);
    }
    all.push(...next);
    frontier = next;
  }
  return { state: current, effects: all };
}

function rendition(id: string, bitrate: number, codecs: string): Rendition {
  return {
    id,
    bitrate,
    codecs,
    mimeType: 'video/mp4',
    segments: [{ seq: 0, start: 0, duration: 4, url: `https://cdn.example/${id}/0.m4s` }],
  };
}

function audioTrack(id: string, group: string, lang: string, isDefault: boolean) {
  return {
    id: `${group}:${id}`,
    contentType: 'audio' as const,
    mimeType: 'audio/mp4',
    lang,
    role: isDefault ? 'main' : 'alternate',
    protection: null,
    renditions: [
      {
        id: `${group}:${id}`,
        bitrate: 128_000,
        codecs: 'mp4a.40.2',
        mimeType: 'audio/mp4',
        segments: [
          { seq: 0, start: 0, duration: 4, url: `https://cdn.example/${group}-${id}.m4s` },
        ],
      },
    ],
  };
}

/** Two video rungs coupled to two audio groups, each group with en and fr. */
function coupledPresentation(): Presentation {
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
            id: 'video-main',
            contentType: 'video',
            mimeType: 'video/mp4',
            protection: null,
            renditions: [
              rendition('v-lo', 300_000, 'avc1.42c01e'),
              rendition('v-hi', 900_000, 'avc1.640028'),
            ],
          },
          audioTrack('en', 'aud-lo', 'en', true),
          audioTrack('fr', 'aud-lo', 'fr', false),
          audioTrack('en', 'aud-hi', 'en', true),
          audioTrack('fr', 'aud-hi', 'fr', false),
        ],
      },
    ],
    couplings: [
      { renditionId: 'v-lo', requires: { audio: 'aud-lo' } },
      { renditionId: 'v-hi', requires: { audio: 'aud-hi' } },
    ],
  };
}

let versionSeq = 1;
function ready(activeVideo: string, activeAudio: string): KernelState {
  const base = initialState();
  return {
    ...base,
    lifecycle: { phase: 'ready' },
    presentation: coupledPresentation(),
    tracks: {
      active: new Map([
        ['video', 'video-main'],
        ['audio', activeAudio],
      ]),
      available: ['video-main'],
    },
    // A unique version per fixture: the arbiter memo is shared across tests
    // that reuse one reducer, and in real use any change bumps the version.
    quality: { ...base.quality, active: activeVideo, version: versionSeq++ },
  };
}

const load: Message = {
  type: 'SEGMENT_LOADED',
  trackId: 'video-main',
  seq: 0,
  bytes: new ArrayBuffer(0),
  rtt: 5,
  size: 100,
};

describe('alt-audio: group following', () => {
  const reduce = compose(altAudio());

  it('a manifest with a low-coupled video selects the low audio group', () => {
    const state = ready('v-lo', 'aud-hi:en');
    const { effects } = settle(reduce, ...reduce(state, load));
    const select = effects.find(
      (e) => e.kind === 'schedule' && (e.then as Message).type === 'SELECT_TRACK',
    );
    expect((select as { then: { trackId: string } } | undefined)?.then.trackId).toBe('aud-lo:en');
  });

  it('a video switch to the high rung drags audio to the high group', () => {
    const state = ready('v-hi', 'aud-lo:en');
    const { effects } = settle(reduce, ...reduce(state, load));
    const select = effects.find(
      (e) => e.kind === 'schedule' && (e.then as Message).type === 'SELECT_TRACK',
    );
    expect((select as { then: { trackId: string } } | undefined)?.then.trackId).toBe('aud-hi:en');
  });

  it('already in the right group: no switch', () => {
    const state = ready('v-lo', 'aud-lo:en');
    const { effects } = settle(reduce, ...reduce(state, load));
    expect(
      effects.some((e) => e.kind === 'schedule' && (e.then as Message).type === 'SELECT_TRACK'),
    ).toBe(false);
  });

  it('a user language choice sticks across a group switch', () => {
    let state = ready('v-lo', 'aud-lo:en');
    // The user picks French.
    [state] = reduce(state, { type: 'SELECT_TRACK', trackId: 'aud-lo:fr' });
    state = {
      ...state,
      tracks: {
        ...state.tracks,
        active: new Map([
          ['video', 'video-main'],
          ['audio', 'aud-lo:fr'],
        ]),
      },
      quality: { ...state.quality, active: 'v-hi' },
    };
    // Now a video switch to the high rung: French is preserved.
    const { effects } = settle(reduce, ...reduce(state, load));
    const select = effects.find(
      (e) => e.kind === 'schedule' && (e.then as Message).type === 'SELECT_TRACK',
    );
    expect((select as { then: { trackId: string } } | undefined)?.then.trackId).toBe('aud-hi:fr');
  });
});

describe('codec-switch: the switch policy', () => {
  const policy = createPolicy();
  const v240 = rendition('v-240', 400_000, 'avc1.42c01e');
  const v360same = rendition('v-360', 800_000, 'avc1.42c01e');
  const v360profile = rendition('v-360p', 800_000, 'avc1.640028');
  const v720hevc = rendition('v-720', 2_500_000, 'hvc1.1.6.L93');

  it('identical strings are seamless without touching the browser', () => {
    expect(policy(v240, v360same)).toBe('seamless');
    expect(policy(null, v720hevc)).toBe('seamless');
  });

  it('a cross-family switch reloads', () => {
    expect(policy(v240, v720hevc)).toBe('reload');
  });

  it('an in-family profile change downgrades to reload when the browser cannot changeType', () => {
    // No SourceBuffer.changeType in node: the kernel default would say
    // changeType, the policy confirms the browser and downgrades.
    expect(canSwitchTo(v240, v360profile)).toBe('changeType');
    expect(policy(v240, v360profile)).toBe('reload');
  });
});
