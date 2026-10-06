import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Effect, KernelState, Presentation, Rendition } from '../../../src/index.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import type { ArbitrationContext } from '../../../src/kernel/rendition-select.js';
import {
  activeRenditions,
  arbitrate,
  audioGroup,
  audioInGroup,
} from '../../../src/kernel/rendition-select.js';
import { parse } from '../../../src/protocols/hls-cmaf/parse.js';
import type { AbrChooser } from '../../../src/types/quality.js';

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

function trackOf(presentation: Presentation, contentType: string) {
  const track = presentation.periods[0]?.tracks.find(
    (t) => t.contentType === contentType && t.role !== 'trick',
  );
  if (track === undefined) throw new Error(`no ${contentType} track`);
  return track;
}

/** The audio group a video rendition's coupling names. */
function groupFor(presentation: Presentation, id: string | null): string | undefined {
  return presentation.couplings.find((c) => c.renditionId === id)?.requires.audio;
}

function context(
  presentation: Presentation,
  overrides: Partial<ArbitrationContext> = {},
): ArbitrationContext {
  const audio = trackOf(presentation, 'audio');
  return {
    renditions: trackOf(presentation, 'video').renditions,
    constraints: new Map(),
    pinned: null,
    current: null,
    couplings: presentation.couplings,
    activeTracks: new Map([
      ['video', 'video-main'],
      ['audio', audio.id],
    ]),
    availableGroups: new Set(['audio:aud1', 'audio:aud2', 'audio:aud3']),
    audio: audio.renditions,
    telemetry: { throughputEwma: 0, currentTime: 0 },
    ...overrides,
  };
}

/** Always takes the highest bitrate it is offered, the way ABR does on a fast link. */
const greedy: AbrChooser = {
  choose: (allowed) => [...allowed].sort((a, b) => b.bitrate - a.bitrate)[0]?.id ?? '',
};

/** Chrome on Linux: no AC-3, no E-AC-3. */
const chrome = (type: string) => !/ac-3|ec-3/.test(type);
/** Safari, Edge, a TV: every codec of the fixture. */
const everything = () => true;

describe('variants that differ only by audio group', () => {
  it('stay one video stream each: the allowed set holds one variant per playlist', () => {
    const presentation = apple();
    const { result } = arbitrate(context(presentation));
    expect(result.allowed).toHaveLength(8);
    expect(result.allowed.every((id) => groupFor(presentation, id) === 'aud1')).toBe(true);
  });

  it('keep the group of the playing variant, so the audio codec does not change', () => {
    const presentation = apple();
    const ac3 = trackOf(presentation, 'video').renditions.find(
      (r) => groupFor(presentation, r.id) === 'aud2',
    ) as Rendition;
    const { result } = arbitrate(context(presentation, { current: ac3.id }));
    expect(result.allowed).toHaveLength(8);
    expect(result.allowed.every((id) => groupFor(presentation, id) === 'aud2')).toBe(true);
    expect(result.selected).toBe(ac3.id);
  });

  it('a group the browser cannot decode never decides, even when it plays', () => {
    const presentation = apple();
    const video = trackOf(presentation, 'video').renditions;
    const ac3 = video.find((r) => groupFor(presentation, r.id) === 'aud2') as Rendition;
    const excludeIds = ['aud2:English'];
    const { result } = arbitrate(
      context(presentation, {
        current: ac3.id,
        constraints: new Map([['codecs', { excludeIds }]]),
      }),
    );
    expect(result.allowed.every((id) => groupFor(presentation, id) === 'aud1')).toBe(true);
  });

  it('a pin on another group resolves to the same video stream, with no warning', () => {
    const presentation = apple();
    const video = trackOf(presentation, 'video').renditions;
    const pinned = video.find(
      (r) =>
        groupFor(presentation, r.id) === 'aud3' && r.playlistUrl?.endsWith('v9/prog_index.m3u8'),
    ) as Rendition;
    const { result, events } = arbitrate(context(presentation, { pinned: pinned.id }));
    const resolved = video.find((r) => r.id === result.selected);
    expect(resolved?.playlistUrl).toBe(pinned.playlistUrl);
    expect(groupFor(presentation, result.selected)).toBe('aud1');
    expect(events).toEqual([]);
  });

  it('a stream with no variant in the playing group keeps them all', () => {
    // The 1080p rung exists only with E-AC-3 audio: the viewer can still
    // reach it, and the audio follows.
    const text = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",URI="aac.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ec3",NAME="English",LANGUAGE="en",URI="ec3.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aac"',
      'v720.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1200000,CODECS="avc1.64001f,ec-3",AUDIO="ec3"',
      'v720.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.640028,ec-3",AUDIO="ec3"',
      'v1080.m3u8',
    ].join('\n');
    const presentation = parse(text, BASE).presentation as Presentation;
    const { result } = arbitrate(
      context(presentation, { availableGroups: new Set(['audio:aac', 'audio:ec3']) }),
    );
    expect(result.allowed).toEqual(['v-1000000', 'v-5000000']);
  });
});

describe('the audio rendition of a track offered in several groups', () => {
  it('is the one in the group the video variant needs', () => {
    const presentation = apple();
    const audio = trackOf(presentation, 'audio').renditions;
    const ec3 = trackOf(presentation, 'video').renditions.find(
      (r) => groupFor(presentation, r.id) === 'aud3',
    ) as Rendition;
    const group = audioGroup(audio, presentation.couplings, new Map(), ec3.id);
    expect(group).toBe('aud3');
    expect(audioInGroup(audio, group).map((r) => r.codecs)).toEqual(['ec-3']);
  });

  it('is the first decodable one before any video plays', () => {
    const presentation = apple();
    const audio = trackOf(presentation, 'audio').renditions;
    const excludeIds = ['aud1:English'];
    expect(audioGroup(audio, presentation.couplings, new Map(), null)).toBe('aud1');
    expect(audioGroup(audio, presentation.couplings, new Map([['x', { excludeIds }]]), null)).toBe(
      'aud2',
    );
  });

  it('is every rendition when no coupling names an audio group', () => {
    const audio = trackOf(apple(), 'audio').renditions;
    expect(audioGroup(audio, [], new Map(), null)).toBeNull();
    expect(audioInGroup(audio, null)).toHaveLength(3);
  });
});

describe('through the reducer', () => {
  function load(decodable: (type: string) => boolean, abr?: AbrChooser) {
    const reduce = createReducer([], undefined, {
      decodable,
      ...(abr !== undefined ? { abr } : {}),
    });
    let state = initialState();
    [state] = reduce(state, { type: 'ATTACH', element: {} as HTMLMediaElement });
    [state] = reduce(state, { type: 'LOAD', url: BASE });
    return reduce(state, { type: 'MANIFEST_LOADED', presentation: apple() });
  }

  function audioBuffer(effects: readonly Effect[]): string | undefined {
    for (const effect of effects) {
      if (effect.kind === 'createSourceBuffer' && effect.sbId.includes('audio')) {
        return effect.codecs;
      }
    }
    return undefined;
  }

  it('one English track, which opens its AAC encoding', () => {
    const [state, effects] = load(everything);
    const audio = state.presentation?.periods[0]?.tracks.filter((t) => t.contentType === 'audio');
    expect(audio?.map((t) => t.id)).toEqual(['aud1:English']);
    expect(audioBuffer(effects)).toContain('mp4a.40.2');
  });

  it('ABR on a fast link never climbs onto a variant of another audio group', () => {
    // The AC-3 variant of v9 has the highest BANDWIDTH of the ladder.
    const [state] = load(everything, greedy);
    expect(state.quality.active).toBe('v-8001098');
  });

  it('in Chrome the AC-3 and E-AC-3 encodings are out, the track stays selectable', () => {
    const [state, effects] = load(chrome, greedy);
    expect(state.tracks.active.get('audio')).toBe('aud1:English');
    expect(state.quality.active).toBe('v-8001098');
    expect(audioBuffer(effects)).toContain('mp4a.40.2');
  });

  it('the adapters resolve the audio playlist of one group only', () => {
    const [state] = load(everything);
    const kernel: KernelState = state;
    const audio = activeRenditions(kernel, ['audio'], kernel.quality.active);
    expect(audio.map((entry) => entry.rendition.id)).toEqual(['aud1:English']);
  });
});
