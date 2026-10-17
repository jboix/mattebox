// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { completeChunks } from '../../../src/containers/mp4-box/index.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import dashLl from '../../../src/protocols/dash-ll/index.js';
import type { IndexedSegments } from '../../../src/types/ir.js';
import type { KernelState, SliceReducer } from '../../../src/types/kernel.js';
import type { Effect } from '../../../src/types/messages.js';
import type { ChunkSplitter } from '../../../src/types/stage.js';

function install() {
  const slices: Array<readonly [string, SliceReducer]> = [];
  let splitter: ChunkSplitter | null = null;
  dashLl().install({
    element: new EventTarget() as unknown as HTMLMediaElement,
    registerSink: () => undefined,
    registerParser: () => undefined,
    capabilities: () => [],
    registerTransform: () => undefined,
    registerNamespace: () => undefined,
    registerChooser: () => undefined,
    registerSwitchPolicy: () => undefined,
    registerTypeProbe: () => undefined,
    registerTimeProbe: () => undefined,
    registerChunkSplitter: (split) => {
      splitter = split;
    },
    getState: () => initialState(),
    addRequestHook: () => () => undefined,
    addResponseHook: () => () => undefined,
    request: async () => new Response(),
    reduce: (name, reducer) => slices.push([name, reducer as SliceReducer]),
    dispatch: () => undefined,
    emit: () => undefined,
    on: () => () => undefined,
  });
  return { slices, splitter: splitter as ChunkSplitter | null };
}

/** Follows zero-delay loop-back schedule effects the way the runner would. */
function settle(
  reduce: ReturnType<typeof createReducer>,
  state: KernelState,
  effects: readonly Effect[],
): KernelState {
  let current = state;
  let frontier = effects;
  while (frontier.length > 0) {
    const next: Effect[] = [];
    for (const effect of frontier) {
      if (effect.kind !== 'schedule' || effect.delayMs !== 0) continue;
      const [reduced, produced] = reduce(current, effect.then);
      current = reduced;
      next.push(...produced);
    }
    frontier = next;
  }
  return current;
}

const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"
  availabilityStartTime="2026-01-01T00:00:00Z" minimumUpdatePeriod="PT30S">
  <ServiceDescription id="0"><Latency referenceId="0" target="3000"/></ServiceDescription>
  <Period id="p0" start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate media="$Number$.m4s" initialization="init.mp4" duration="4000"
        timescale="1000" startNumber="0" availabilityTimeOffset="3" availabilityTimeComplete="false"/>
      <Representation id="v" bandwidth="200000" codecs="avc1.64001e"/>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('the dash-ll stage', () => {
  it('stands in for dash-cmaf and dash-live, and registers the CMAF chunk splitter', () => {
    const stage = dashLl();
    expect(stage.provides).toEqual(
      expect.arrayContaining(['dash-ll', 'dash-cmaf', 'dash-live', 'application/dash+xml']),
    );
    const { slices, splitter } = install();
    expect(slices.map(([name]) => name)).toEqual(['dash', 'dash-live']);
    expect(splitter).toBe(completeChunks);
  });

  it('reads the MPD as a low-latency one', () => {
    const reduce = createReducer(install().slices);
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: 'https://live.example/live.mpd' });
    const [next, fx] = reduce(state, {
      type: 'SEGMENT_LOADED',
      trackId: 'manifest',
      seq: -1,
      bytes: new TextEncoder().encode(MPD).buffer as ArrayBuffer,
      rtt: 10,
      size: MPD.length,
    });
    const loaded = settle(reduce, next, fx);
    expect(loaded.presentation?.live?.holdBack).toBe(3);
    const segments = loaded.presentation?.periods[0]?.tracks[0]?.renditions[0]
      ?.segments as IndexedSegments;
    expect(segments).toMatchObject({ availabilityOffset: 3, chunked: true });
  });
});
