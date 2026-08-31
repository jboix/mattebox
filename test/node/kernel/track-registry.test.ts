import { describe, expect, it } from 'vitest';
import type { ContentType } from '../../../src/index.js';
import { createBus } from '../../../src/kernel/bus.js';
import { createEffectRunner } from '../../../src/kernel/effects.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { createTrackRegistry } from '../../../src/kernel/track-registry.js';
import { vodFixture } from './helpers.js';

function stack(sinks: ContentType[]) {
  const bus = createBus({ reducer: createReducer(), initial: initialState(), now: () => 0 });
  const runner = createEffectRunner();
  runner.register('emit', (effect) => {
    bus.emitEvent(effect.event, effect.payload);
    return undefined;
  });
  bus.setEffectSink((effects) => runner.run(effects));
  const registry = createTrackRegistry({
    getState: () => bus.getState(),
    dispatch: (cmd) => bus.dispatch(cmd),
    emitEvent: (event, payload) => bus.emitEvent(event, payload),
    hasSink: (contentType) => sinks.includes(contentType),
  });
  return { bus, registry };
}

describe('track registry', () => {
  it('enumerates tracks from the presentation and reports the active one', () => {
    const { bus, registry } = stack(['video', 'audio']);
    expect(registry.available).toEqual([]);

    bus.absorb({ type: 'MANIFEST_LOADED', presentation: vodFixture });
    expect(registry.available.map((t) => t.id)).toEqual(['v', 'a']);
    // Default activation picked the first track per media content type.
    expect(registry.active('audio')?.id).toBe('a');
    expect(registry.active('video')?.id).toBe('v');

    registry.select('a');
    expect(registry.active('audio')?.id).toBe('a');
    expect(registry.active('audio')?.lang).toBe('de');
  });

  it('emits tracks:changed when the presentation changes', () => {
    const { bus } = stack(['video']);
    const events: unknown[] = [];
    bus.on('tracks:changed', (payload) => events.push(payload));
    bus.absorb({ type: 'MANIFEST_LOADED', presentation: vodFixture });
    expect(events).toEqual([{ available: ['v', 'a'] }]);
  });

  it('a track without a registered sink is enumerated but not selectable', () => {
    // Only a video sink: audio exists in the manifest but cannot render.
    const { bus, registry } = stack(['video']);
    bus.absorb({ type: 'MANIFEST_LOADED', presentation: vodFixture });

    expect(registry.available.map((t) => t.id)).toContain('a');
    expect(registry.selectable('v')).toBe(true);
    expect(registry.selectable('a')).toBe(false);

    const rejections: unknown[] = [];
    bus.on('command:rejected', (payload) => rejections.push(payload));
    registry.select('a');
    expect(rejections).toEqual([
      { command: 'SELECT_TRACK', reason: "no sink registered for 'audio'" },
    ]);
    // Default activation set audio at manifest time; the refused select
    // must not have dispatched anything on top of it.
    expect(bus.getState().tracks.active.get('audio')).toBe('a');
  });

  it('an unknown track id falls through to the reducer rejection', () => {
    const { bus, registry } = stack(['video']);
    bus.absorb({ type: 'MANIFEST_LOADED', presentation: vodFixture });
    const rejections: unknown[] = [];
    bus.on('command:rejected', (payload) => rejections.push(payload));
    registry.select('ghost');
    expect(rejections).toEqual([{ command: 'SELECT_TRACK', reason: 'unknown track: ghost' }]);
  });
});
