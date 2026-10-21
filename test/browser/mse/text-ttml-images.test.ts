import { afterEach, describe, expect, it } from 'vitest';
import type { TtmlApi } from '../../../src/stages/text-ttml/index.js';
import textTtml from '../../../src/stages/text-ttml/index.js';
import type { StageContext } from '../../../src/types/stage.js';

/**
 * IMSC1 image cues drawn into the page's container. A cue turns active
 * only while media plays, so the element here is a stand-in whose text
 * tracks the test drives: the stage reads `mode`, `activeCues` and the
 * list's events, as on a real element.
 */

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

class FakeTrack extends EventTarget {
  mode: TextTrackMode = 'showing';
  activeCues: unknown[] = [];
  show(...cues: unknown[]): void {
    this.activeCues = cues;
    this.dispatchEvent(new Event('cuechange'));
  }
}

class FakeTrackList extends EventTarget {
  [index: number]: FakeTrack;
  length = 0;
  add(track: FakeTrack): void {
    this[this.length] = track;
    this.length += 1;
    this.dispatchEvent(new Event('addtrack'));
  }
}

const image = (left: number) => ({
  payload: { image: 'data:image/png;base64,AA==', left, top: 80, width: 50, height: 10 },
});

function compose() {
  const tracks = new FakeTrackList();
  let api: TtmlApi | undefined;
  const ctx = {
    element: { textTracks: tracks },
    registerSink() {},
    registerParser() {},
    registerNamespace(_name: string, value: TtmlApi) {
      api = value;
    },
    getState: () => ({}),
    dispatch() {},
    on: () => () => {},
  } as unknown as StageContext;
  const teardown = textTtml().install(ctx);
  if (typeof teardown === 'function') teardowns.push(teardown);
  if (api === undefined) throw new Error('no ttml namespace');
  return { tracks, api, container: document.createElement('div') };
}

describe('IMSC1 image subtitles', () => {
  it('draws the active image cues of the showing track, placed by their region', () => {
    const { tracks, api, container } = compose();
    const track = new FakeTrack();
    tracks.add(track);
    api.showImages(container);
    track.show(image(10), { text: 'not an image' });
    const drawn = container.querySelectorAll('img');
    expect(drawn).toHaveLength(1);
    const img = drawn[0] as HTMLImageElement;
    expect(img.alt).toBe('');
    expect(img.style.left).toBe('10%');
    expect(img.style.top).toBe('80%');
    expect(img.style.width).toBe('50%');
    track.show();
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });

  it('watches a track added later and skips a track that is not showing', () => {
    const { tracks, api, container } = compose();
    api.showImages(container);
    const hidden = new FakeTrack();
    hidden.mode = 'hidden';
    tracks.add(hidden);
    hidden.show(image(0));
    expect(container.querySelectorAll('img')).toHaveLength(0);
    const later = new FakeTrack();
    tracks.add(later);
    later.show(image(20), image(30));
    expect(container.querySelectorAll('img')).toHaveLength(2);
  });

  it('stops and clears the container on null, on a new container and on teardown', () => {
    const { tracks, api, container } = compose();
    const track = new FakeTrack();
    tracks.add(track);
    api.showImages(container);
    track.show(image(10));
    const next = document.createElement('div');
    api.showImages(next);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(next.querySelectorAll('img')).toHaveLength(1);
    api.showImages(null);
    expect(next.querySelectorAll('img')).toHaveLength(0);
    track.show(image(40));
    expect(next.querySelectorAll('img')).toHaveLength(0);
    api.showImages(next);
    expect(next.querySelectorAll('img')).toHaveLength(1);
    for (const teardown of teardowns.splice(0)) teardown();
    expect(next.querySelectorAll('img')).toHaveLength(0);
  });
});
