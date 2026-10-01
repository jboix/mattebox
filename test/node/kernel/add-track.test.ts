import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import type { Track } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { Effect } from '../../../src/types/messages.js';
import { vodFixture } from './helpers.js';

const reduce = createReducer();

const CAPTIONS: Track = {
  id: 'cea608:CC1',
  contentType: 'text',
  mimeType: 'application/cea-608',
  role: 'caption',
  instreamId: 'CC1',
  protection: null,
  renditions: [],
};

function loaded(): KernelState {
  const [state] = reduce(initialState(), { type: 'MANIFEST_LOADED', presentation: vodFixture });
  return state;
}

function ids(state: KernelState): string[] {
  return (state.presentation?.periods[0]?.tracks ?? []).map((t) => t.id);
}

function rejected(effects: readonly Effect[]): unknown {
  const effect = effects.find((e) => e.kind === 'emit' && e.event === 'command:rejected');
  return effect?.kind === 'emit' ? effect.payload : undefined;
}

describe('ADD_TRACK', () => {
  it('is rejected without a source', () => {
    const [state, effects] = reduce(initialState(), { type: 'ADD_TRACK', track: CAPTIONS });
    expect(state.presentation).toBeNull();
    expect(rejected(effects)).toEqual({ command: 'ADD_TRACK', reason: 'no source' });
  });

  it('joins the presentation and reports the new track list', () => {
    const [state, effects] = reduce(loaded(), { type: 'ADD_TRACK', track: CAPTIONS });
    expect(ids(state)).toEqual(['v', 'a', 'cea608:CC1']);
    expect(state.tracks.available).toEqual(['v', 'a', 'cea608:CC1']);
    expect(effects).toContainEqual({
      kind: 'emit',
      event: 'tracks:changed',
      payload: { available: ['v', 'a', 'cea608:CC1'] },
    });
  });

  it('is rejected for an id that exists', () => {
    const [state] = reduce(loaded(), { type: 'ADD_TRACK', track: CAPTIONS });
    const [again, effects] = reduce(state, { type: 'ADD_TRACK', track: CAPTIONS });
    expect(ids(again)).toEqual(['v', 'a', 'cea608:CC1']);
    expect(rejected(effects)).toEqual({
      command: 'ADD_TRACK',
      reason: 'track exists: cea608:CC1',
    });
  });

  it('stays across a playlist merge, which hands over the adapter presentation', () => {
    const [added] = reduce(loaded(), { type: 'ADD_TRACK', track: CAPTIONS });
    const [state, effects] = reduce(added, { type: 'MANIFEST_LOADED', presentation: vodFixture });
    expect(ids(state)).toEqual(['v', 'a', 'cea608:CC1']);
    // The track list did not change, so no tracks:changed.
    expect(effects.some((e) => e.kind === 'emit' && e.event === 'tracks:changed')).toBe(false);
  });

  it('goes with the source: the next presentation does not carry it over', () => {
    let [state] = reduce(loaded(), { type: 'ADD_TRACK', track: CAPTIONS });
    // A load replaces a source through UNLOAD, which resets the kernel.
    [state] = reduce(state, { type: 'UNLOAD' });
    expect(state.tracks.added).toBeUndefined();
    [state] = reduce(state, { type: 'MANIFEST_LOADED', presentation: vodFixture });
    expect(ids(state)).toEqual(['v', 'a']);
  });
});
