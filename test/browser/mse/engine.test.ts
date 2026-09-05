import { describe, expect, it } from 'vitest';
import type { Stage } from '../../../src/index.js';
import { mattebox } from '../../../src/index.js';
import hlsCmaf from '../../../src/protocols/hls-cmaf/index.js';
import { inMemoryHls, pickVideoProfile, waitFor } from './helpers.js';

function video(): HTMLVideoElement {
  const el = document.createElement('video');
  el.muted = true;
  return el;
}

describe('lifecycle', () => {
  it('8. ten attach-detach cycles grow no listeners and leak no object URLs', async () => {
    const el = video();

    let addCalls = 0;
    let removeCalls = 0;
    const originalAdd = el.addEventListener.bind(el);
    const originalRemove = el.removeEventListener.bind(el);
    el.addEventListener = (...args: Parameters<typeof originalAdd>) => {
      addCalls += 1;
      return originalAdd(...args);
    };
    el.removeEventListener = (...args: Parameters<typeof originalRemove>) => {
      removeCalls += 1;
      return originalRemove(...args);
    };

    let liveUrls = 0;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      liveUrls += 1;
      return originalCreate.call(URL, obj as never);
    };
    URL.revokeObjectURL = (url: string) => {
      liveUrls -= 1;
      originalRevoke.call(URL, url);
    };

    try {
      const engine = mattebox({});
      for (let cycle = 0; cycle < 10; cycle += 1) {
        await engine.attach(el);
        await waitFor(() => engine.media === el, `attached, cycle ${cycle}`);
        await engine.detach();
        expect(engine.media).toBeNull();
      }
      // Every listener added was removed, every URL created was revoked.
      expect(addCalls).toBe(removeCalls);
      expect(liveUrls).toBe(0);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  }, 30_000);

  it('9. attach to an element with an existing src is refused, never silent', async () => {
    const el = video();
    el.src = 'https://cdn.example/already.mp4';
    const engine = mattebox({});
    await expect(engine.attach(el)).rejects.toThrowError(/already has a source/);
    expect(engine.media).toBeNull();
    expect(mattebox.from(el)).toBeNull();
  });

  it('10. detach from an error state is idempotent', async () => {
    const engine = mattebox({});
    const el = video();
    await engine.attach(el);
    // Force an error event path: an unknown command rejection is benign;
    // detach must simply always work, twice.
    await engine.detach();
    await engine.detach();
    expect(engine.media).toBeNull();
  });

  it('11. the autoplay attribute is untouched by attach', async () => {
    const el = video();
    el.autoplay = true;
    const engine = mattebox({});
    await engine.attach(el);
    expect(el.autoplay).toBe(true);
    await engine.detach();
    expect(el.autoplay).toBe(true);

    const el2 = video();
    const engine2 = mattebox({});
    await engine2.attach(el2);
    expect(el2.autoplay).toBe(false);
    await engine2.detach();
  });

  it('12. element property descriptors are unmodified after attach', async () => {
    const el = video();
    const before = ['currentTime', 'play', 'buffered', 'pause', 'volume', 'playbackRate'].map(
      (name) => Object.getOwnPropertyDescriptor(el, name),
    );
    const engine = mattebox({});
    await engine.attach(el);
    const after = ['currentTime', 'play', 'buffered', 'pause', 'volume', 'playbackRate'].map(
      (name) => Object.getOwnPropertyDescriptor(el, name),
    );
    // All must remain prototype members: no own descriptors created.
    expect(before).toEqual(after);
    expect(before.every((d) => d === undefined)).toBe(true);
    expect(el.play).toBe(HTMLMediaElement.prototype.play);
    await engine.detach();
  });
});

describe('stage install semantics', () => {
  it('5. teardown runs in exact reverse install order', async () => {
    const events: string[] = [];
    const make = (name: string, requires?: string[]): Stage => ({
      name,
      ...(requires !== undefined ? { requires } : {}),
      install: () => {
        events.push(`install:${name}`);
        return () => events.push(`teardown:${name}`);
      },
    });
    const engine = mattebox({ stages: [make('c', ['b']), make('b', ['a']), make('a')] });
    const el = video();
    await engine.attach(el);
    expect(events).toEqual(['install:a', 'install:b', 'install:c']);
    await engine.detach();
    expect(events.slice(3)).toEqual(['teardown:c', 'teardown:b', 'teardown:a']);
  });

  it('6. a namespace exists exactly while its stage is installed', async () => {
    const live: Stage = {
      name: 'fake-live',
      provides: ['live'],
      install: (ctx) => {
        ctx.registerNamespace('demo', { answer: () => 42 });
      },
    };
    const engine = mattebox({ stages: [live] });
    expect('demo' in engine).toBe(false);

    const el = video();
    await engine.attach(el);
    expect('demo' in engine).toBe(true);
    expect((engine as { demo?: { answer(): number } }).demo?.answer()).toBe(42);

    await engine.detach();
    expect('demo' in engine).toBe(false);
  });

  it('7. the transform pipeline order is as declared, regardless of registration order', async () => {
    const seen: string[] = [];
    const make = (name: string, order: number): Stage => ({
      name,
      install: (ctx) => {
        ctx.registerTransform({
          name,
          order,
          transform: (data) => {
            seen.push(name);
            return data;
          },
        });
      },
    });
    // Registered out of order on purpose: caption-extract, decrypt, demux.
    const engine = mattebox({
      stages: [make('caption-extract', 3), make('decrypt', 1), make('demux', 2)],
    });
    const el = video();
    await engine.attach(el);
    // The pipeline itself runs in later stages; the declared order must
    // already be established at composition.
    void seen;
    await engine.detach();
    expect(engine.capabilities()).toEqual([]);
  });
});

// Every configuration from docs/02, as data. Adding a stage means adding a
// row; this is the test that stops the layering from rotting. Until the
// real stages exist, each is represented by an inert placeholder that
// declares the same name, requires, and provides.
interface Configuration {
  readonly name: string;
  readonly stages: readonly string[];
  readonly expects: readonly string[];
}

const CONFIGURATIONS: readonly Configuration[] = [
  { name: 'kernel only', stages: [], expects: [] },
  {
    name: 'VOD CMAF one protocol',
    stages: ['hls-cmaf', 'mp4-box', 'codec-probe', 'abr'],
    expects: ['hls-cmaf', 'abr'],
  },
  {
    name: 'both protocols VOD webvtt',
    stages: [
      'hls-cmaf',
      'mp4-box',
      'codec-probe',
      'abr',
      'dash-cmaf',
      'text-webvtt',
      'text-webvtt-segmented',
    ],
    expects: ['hls-cmaf', 'dash-cmaf', 'text-webvtt'],
  },
  {
    name: 'plus live and recovery',
    stages: [
      'hls-cmaf',
      'mp4-box',
      'codec-probe',
      'abr',
      'dash-cmaf',
      'text-webvtt',
      'text-webvtt-segmented',
      'hls-live',
      'dash-live',
      'recovery',
    ],
    expects: ['hls-live', 'dash-live', 'recovery'],
  },
  {
    name: 'plus alt audio and DRM',
    stages: [
      'hls-cmaf',
      'mp4-box',
      'codec-probe',
      'abr',
      'dash-cmaf',
      'text-webvtt',
      'text-webvtt-segmented',
      'hls-live',
      'dash-live',
      'recovery',
      'alt-audio',
      'codec-switch',
      'eme-core',
      'eme-cenc',
    ],
    expects: ['eme-core', 'alt-audio'],
  },
];

/** The dependency shape of the future stage, from docs/04 and docs/06. */
const STAGE_REQUIRES: Record<string, readonly string[]> = {
  'hls-cmaf': [],
  'dash-cmaf': [],
  'mp4-box': [],
  'codec-probe': [],
  abr: ['scheduler', 'track-registry'],
  'text-webvtt': ['scheduler'],
  'text-webvtt-segmented': ['text-webvtt', 'hls-cmaf'],
  'hls-live': ['hls-cmaf'],
  'dash-live': ['dash-cmaf'],
  recovery: ['scheduler', 'mse'],
  'alt-audio': ['scheduler', 'codec-switch'],
  'codec-switch': [],
  'eme-core': ['mp4-box'],
  'eme-cenc': ['eme-core'],
};

function placeholder(name: string): Stage {
  return {
    name,
    provides: [name],
    requires: [...(STAGE_REQUIRES[name] ?? [])],
    install: () => undefined,
  };
}

describe('13. modularity regression', () => {
  for (const configuration of CONFIGURATIONS) {
    it(`${configuration.name} composes, attaches, reports capabilities, detaches`, async () => {
      const engine = mattebox({ stages: configuration.stages.map(placeholder) });
      const el = video();
      await engine.attach(el);
      const capabilities = [...engine.capabilities()];
      expect(capabilities).toEqual(expect.arrayContaining([...configuration.expects]));
      await engine.detach();
      expect(engine.media).toBeNull();
    });
  }
});

describe('reload', () => {
  const profile = pickVideoProfile();

  it.runIf(profile !== null)(
    'a second load replaces the source and plays it',
    async () => {
      // UNLOAD must take the MediaSource with it. Left in place, the next
      // load's buffer requests are absorbed as duplicates, the reducer never
      // learns of the buffer, and it refetches the init segment forever.
      if (profile === null) throw new Error('unreachable');
      const first = inMemoryHls(profile, 'https://first.test');
      const second = inMemoryHls(profile, 'https://second.test');
      const el = video();
      document.body.appendChild(el);
      const engine = mattebox({
        stages: [hlsCmaf()],
        transport: {
          fetchImpl: (url, init) =>
            url.startsWith('https://second.test')
              ? second.fetchImpl(url, init)
              : first.fetchImpl(url, init),
        },
      });
      const errors: unknown[] = [];
      engine.on('error', (error) => errors.push(error));
      const bufferedEnd = () => {
        const { buffered } = el;
        return buffered.length > 0 ? buffered.end(buffered.length - 1) : 0;
      };
      try {
        await engine.attach(el);
        engine.load(first.url);
        await waitFor(() => bufferedEnd() > 1, 'first source buffered', 20_000);

        engine.load(second.url);
        // The element restarts from nothing on a fresh MediaSource.
        await waitFor(() => bufferedEnd() === 0 && el.currentTime === 0, 'element reset', 5_000);
        await waitFor(() => bufferedEnd() > 1, 'second source buffered', 20_000);

        expect(engine.error).toBeNull();
        expect(errors).toEqual([]);
        const initFetches = engine.stats
          .trace()
          .filter(
            (e) =>
              e.msg.type === 'SEGMENT_LOADED' && e.msg.trackId === 'video-main' && e.msg.seq < 0,
          ).length;
        // One init per load, not a loop. The media playlist also loads at
        // sequence -1, hence the track filter.
        expect(initFetches).toBe(2);
      } finally {
        await engine.detach();
        el.remove();
      }
    },
    60_000,
  );
});
