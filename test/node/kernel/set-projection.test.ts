import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { Effect } from '../../../src/types/messages.js';
import { vodFixture } from './helpers.js';

const reduce = createReducer();

function loaded(): KernelState {
  const [state] = reduce(initialState(), { type: 'MANIFEST_LOADED', presentation: vodFixture });
  return state;
}

/** The projection of rendition `v-1` in the state's presentation. */
function projectionOf(state: KernelState): string | undefined {
  return state.presentation?.periods[0]?.tracks[0]?.renditions[0]?.projection;
}

function rejected(effects: readonly Effect[]): unknown {
  const effect = effects.find((e) => e.kind === 'emit' && e.event === 'command:rejected');
  return effect?.kind === 'emit' ? effect.payload : undefined;
}

describe('SET_PROJECTION', () => {
  const command = {
    type: 'SET_PROJECTION',
    renditionId: 'v-1',
    projection: 'equirectangular',
  } as const;

  it('is rejected without a source, and for an unknown rendition', () => {
    const [, none] = reduce(initialState(), command);
    expect(rejected(none)).toEqual({ command: 'SET_PROJECTION', reason: 'no source' });
    const [, unknown] = reduce(loaded(), { ...command, renditionId: 'nope' });
    expect(rejected(unknown)).toEqual({
      command: 'SET_PROJECTION',
      reason: 'unknown rendition: nope',
    });
  });

  it('gives the rendition its projection and reports the presentation changed', () => {
    const [state, effects] = reduce(loaded(), command);
    expect(projectionOf(state)).toBe('equirectangular');
    expect(effects).toContainEqual({
      kind: 'emit',
      event: 'presentation:changed',
      payload: { id: 'vod-1' },
    });
  });

  it('is rejected where the rendition has one: the manifest wins', () => {
    const [state] = reduce(loaded(), command);
    const [again, effects] = reduce(state, { ...command, projection: 'half-equirectangular' });
    expect(projectionOf(again)).toBe('equirectangular');
    expect(rejected(effects)).toEqual({
      command: 'SET_PROJECTION',
      reason: 'projection exists: v-1',
    });
  });

  it('stays across a playlist merge, which hands over the adapter presentation', () => {
    const [set] = reduce(loaded(), command);
    const [state] = reduce(set, { type: 'MANIFEST_LOADED', presentation: vodFixture });
    expect(projectionOf(state)).toBe('equirectangular');
  });

  it('goes with the source', () => {
    let [state] = reduce(loaded(), command);
    [state] = reduce(state, { type: 'UNLOAD' });
    expect(state.tracks.projections).toBeUndefined();
    [state] = reduce(state, { type: 'MANIFEST_LOADED', presentation: vodFixture });
    expect(projectionOf(state)).toBeUndefined();
  });
});

/** The frame packing of rendition `v-1` in the state's presentation. */
function framePackingOf(state: KernelState): string | undefined {
  return state.presentation?.periods[0]?.tracks[0]?.renditions[0]?.framePacking;
}

describe('SET_FRAME_PACKING', () => {
  const command = {
    type: 'SET_FRAME_PACKING',
    renditionId: 'v-1',
    framePacking: 'top-bottom',
  } as const;

  it('is rejected without a source, and for an unknown rendition', () => {
    const [, none] = reduce(initialState(), command);
    expect(rejected(none)).toEqual({ command: 'SET_FRAME_PACKING', reason: 'no source' });
    const [, unknown] = reduce(loaded(), { ...command, renditionId: 'nope' });
    expect(rejected(unknown)).toEqual({
      command: 'SET_FRAME_PACKING',
      reason: 'unknown rendition: nope',
    });
  });

  it('gives the rendition its frame packing and reports the presentation changed', () => {
    const [state, effects] = reduce(loaded(), command);
    expect(framePackingOf(state)).toBe('top-bottom');
    expect(effects).toContainEqual({
      kind: 'emit',
      event: 'presentation:changed',
      payload: { id: 'vod-1' },
    });
  });

  it('is rejected where the rendition has one: the manifest wins', () => {
    const [state] = reduce(loaded(), command);
    const [again, effects] = reduce(state, { ...command, framePacking: 'side-by-side' });
    expect(framePackingOf(again)).toBe('top-bottom');
    expect(rejected(effects)).toEqual({
      command: 'SET_FRAME_PACKING',
      reason: 'frame packing exists: v-1',
    });
  });

  it('keeps the projection the other command set, and stays across a playlist merge', () => {
    let [state] = reduce(loaded(), {
      type: 'SET_PROJECTION',
      renditionId: 'v-1',
      projection: 'equirectangular',
    });
    [state] = reduce(state, command);
    expect(projectionOf(state)).toBe('equirectangular');
    expect(framePackingOf(state)).toBe('top-bottom');
    [state] = reduce(state, { type: 'MANIFEST_LOADED', presentation: vodFixture });
    expect(projectionOf(state)).toBe('equirectangular');
    expect(framePackingOf(state)).toBe('top-bottom');
  });

  it('goes with the source', () => {
    let [state] = reduce(loaded(), command);
    [state] = reduce(state, { type: 'UNLOAD' });
    expect(state.tracks.framePackings).toBeUndefined();
    [state] = reduce(state, { type: 'MANIFEST_LOADED', presentation: vodFixture });
    expect(framePackingOf(state)).toBeUndefined();
  });
});
