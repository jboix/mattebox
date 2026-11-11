/**
 * The main video track behind an I-frame track. A scan or a scrub switches
 * the video to the I-frame track for a while, and the quality API reads its
 * renditions from the track it replaced, so a quality menu keeps its list.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KernelState, Presentation } from '../../../src/index.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { parse } from '../../../src/protocols/hls-cmaf/parse.js';

const BASE = 'https://cdn.example/master.m3u8';

function apple(): Presentation {
  const text = readFileSync(
    join(import.meta.dirname, '../../fixtures/manifests/apple-advanced-fmp4-master.m3u8'),
    'utf8',
  );
  const presentation = parse(text, BASE).presentation;
  if (presentation === null) throw new Error('the fixture did not parse');
  return presentation;
}

const reduce = createReducer([], undefined, { decodable: () => true });

function loaded(): KernelState {
  let state = initialState();
  [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
  [state] = reduce(state, { type: 'LOAD', url: BASE });
  [state] = reduce(state, { type: 'MANIFEST_LOADED', presentation: apple() });
  return state;
}

function videoTracks(state: KernelState) {
  const tracks = state.presentation?.periods[0]?.tracks ?? [];
  const main = tracks.find((t) => t.contentType === 'video' && t.role !== 'trick');
  const trick = tracks.find((t) => t.contentType === 'video' && t.role === 'trick');
  if (main === undefined || trick === undefined) throw new Error('no main and I-frame tracks');
  return { main, trick };
}

describe('the track behind an I-frame track', () => {
  it('is the main track while the I-frame track plays, and clears on the way back', () => {
    let state = loaded();
    const { main, trick } = videoTracks(state);
    expect(state.tracks.active.get('video')).toBe(main.id);
    expect(state.tracks.behindTrick).toBeUndefined();

    [state] = reduce(state, { type: 'SELECT_TRACK', trackId: trick.id, apply: 'now' });
    expect(state.tracks.active.get('video')).toBe(trick.id);
    expect(state.tracks.behindTrick).toBe(main.id);

    // A second switch to the I-frame track keeps the main track it replaced.
    [state] = reduce(state, { type: 'SELECT_TRACK', trackId: trick.id, apply: 'now' });
    expect(state.tracks.behindTrick).toBe(main.id);

    [state] = reduce(state, { type: 'SELECT_TRACK', trackId: main.id, apply: 'now' });
    expect(state.tracks.active.get('video')).toBe(main.id);
    expect(state.tracks.behindTrick).toBeUndefined();
  });

  it('stays through a switch of another kind of track', () => {
    let state = loaded();
    const { main, trick } = videoTracks(state);
    const audio = state.presentation?.periods[0]?.tracks.find((t) => t.contentType === 'audio');
    [state] = reduce(state, { type: 'SELECT_TRACK', trackId: trick.id, apply: 'now' });
    if (audio !== undefined) {
      [state] = reduce(state, { type: 'SELECT_TRACK', trackId: audio.id, apply: 'now' });
    }
    expect(state.tracks.behindTrick).toBe(main.id);
  });
});
