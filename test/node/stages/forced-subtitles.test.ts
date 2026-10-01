import { describe, expect, it } from 'vitest';
import forcedSubtitles, { pickForced } from '../../../src/stages/forced-subtitles/index.js';
import type { ContentType, Track } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { Command } from '../../../src/types/messages.js';
import type { Capability, StageContext } from '../../../src/types/stage.js';

function track(id: string, contentType: ContentType, extra: Partial<Track> = {}): Track {
  return {
    id,
    contentType,
    mimeType: contentType === 'text' ? 'text/vtt' : 'audio/mp4',
    protection: null,
    renditions: [],
    ...extra,
  };
}

const AUDIO_EN = track('a:en', 'audio', { lang: 'en' });
const AUDIO_FR = track('a:fr', 'audio', { lang: 'fr' });
const SUBS_EN = track('s:en', 'text', { lang: 'en' });
const FORCED_EN = track('s:en-forced', 'text', { lang: 'en', forced: true });
const FORCED_FR = track('s:fr-forced', 'text', { lang: 'fr', forced: true });

const VTT: Capability = { contentType: 'text', mimeType: 'text/vtt' };

/**
 * A context whose dispatch applies track commands the way the reducer does
 * and emits tracks:selected, so the stage sees its own selections.
 */
function harness(tracks: readonly Track[], options: { enabled?: boolean } = {}) {
  const active = new Map<ContentType, string>();
  const firstAudio = tracks.find((t) => t.contentType === 'audio');
  if (firstAudio !== undefined) active.set('audio', firstAudio.id);
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const commands: Command[] = [];
  const namespaces: Record<string, unknown> = {};
  let loaded = false;
  const emit = (event: string, payload: unknown) => {
    for (const fn of listeners.get(event) ?? []) fn(payload);
  };
  const ctx = {
    getState: () =>
      ({
        presentation: loaded ? { periods: [{ id: 'p0', start: 0, tracks }] } : null,
        tracks: { active, available: tracks.map((t) => t.id) },
      }) as unknown as KernelState,
    capabilities: () => [VTT],
    registerNamespace: (name: string, api: unknown) => {
      namespaces[name] = api;
    },
    on: (event: string, fn: (payload: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return () => undefined;
    },
    dispatch: (cmd: Command) => {
      commands.push(cmd);
      if (cmd.type === 'SELECT_TRACK') {
        const chosen = tracks.find((t) => t.id === cmd.trackId) as Track;
        active.set(chosen.contentType, chosen.id);
        emit('tracks:selected', { contentType: chosen.contentType, trackId: chosen.id });
      } else if (cmd.type === 'DESELECT_TRACK') {
        active.delete(cmd.contentType);
        emit('tracks:selected', { contentType: cmd.contentType, trackId: null });
      }
    },
  } as unknown as StageContext;
  forcedSubtitles(options).install(ctx);
  return {
    load() {
      loaded = true;
      emit('tracks:changed', {});
    },
    text: () => active.get('text') ?? null,
    select: (trackId: string) => ctx.dispatch({ type: 'SELECT_TRACK', trackId }),
    deselect: () => ctx.dispatch({ type: 'DESELECT_TRACK', contentType: 'text' }),
    commands,
    api: () => namespaces.forcedSubtitles as { enabled: boolean },
  };
}

describe('pickForced', () => {
  it('matches the audio language exactly, then by primary subtag, then takes the first', () => {
    const enUs = track('s:en-us', 'text', { lang: 'en-US', forced: true });
    expect(pickForced([FORCED_FR, enUs, FORCED_EN], 'en')?.id).toBe('s:en-forced');
    expect(pickForced([FORCED_FR, enUs], 'en')?.id).toBe('s:en-us');
    expect(pickForced([FORCED_FR, FORCED_EN], 'EN-gb')?.id).toBe('s:en-forced');
    // Apple: with no other means to choose, the first forced track.
    expect(pickForced([FORCED_FR, FORCED_EN], 'de')?.id).toBe('s:fr-forced');
    expect(pickForced([FORCED_FR, FORCED_EN], null)?.id).toBe('s:fr-forced');
    expect(pickForced([], 'en')).toBeNull();
  });
});

describe('forced-subtitles stage', () => {
  it('shows the forced track for the audio language on load', () => {
    const h = harness([AUDIO_EN, AUDIO_FR, SUBS_EN, FORCED_FR, FORCED_EN]);
    h.load();
    expect(h.text()).toBe('s:en-forced');
  });

  it('follows an audio switch', () => {
    const h = harness([AUDIO_EN, AUDIO_FR, SUBS_EN, FORCED_FR, FORCED_EN]);
    h.load();
    h.select('a:fr');
    expect(h.text()).toBe('s:fr-forced');
  });

  it('leaves a regular subtitle the user selected, across audio switches', () => {
    const h = harness([AUDIO_EN, AUDIO_FR, SUBS_EN, FORCED_FR, FORCED_EN]);
    h.load();
    h.select('s:en');
    h.select('a:fr');
    expect(h.text()).toBe('s:en');
  });

  it('shows the forced track again when the user turns subtitles off', () => {
    const h = harness([AUDIO_EN, SUBS_EN, FORCED_EN]);
    h.load();
    h.select('s:en');
    h.deselect();
    expect(h.text()).toBe('s:en-forced');
  });

  it('selects nothing without forced tracks', () => {
    const h = harness([AUDIO_EN, SUBS_EN]);
    h.load();
    expect(h.text()).toBeNull();
    expect(h.commands).toEqual([]);
  });

  it('skips a forced track in a format no stage plays', () => {
    const ttml = track('s:en-ttml', 'text', {
      lang: 'en',
      forced: true,
      mimeType: 'application/ttml+xml',
    });
    const h = harness([AUDIO_EN, ttml, FORCED_FR]);
    h.load();
    expect(h.text()).toBe('s:fr-forced');
  });

  it('enabled: false shows nothing until switched on at runtime', () => {
    const h = harness([AUDIO_EN, FORCED_EN], { enabled: false });
    h.load();
    expect(h.text()).toBeNull();
    h.deselect();
    expect(h.text()).toBeNull();
    h.api().enabled = true;
    expect(h.api().enabled).toBe(true);
    expect(h.text()).toBe('s:en-forced');
  });

  it('switching off at runtime removes the forced track, not a regular one', () => {
    const h = harness([AUDIO_EN, SUBS_EN, FORCED_EN]);
    h.load();
    h.api().enabled = false;
    expect(h.text()).toBeNull();
    h.select('s:en');
    h.api().enabled = true;
    h.api().enabled = false;
    expect(h.text()).toBe('s:en');
  });
});
