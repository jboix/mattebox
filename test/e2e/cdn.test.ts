import { afterEach, expect, it } from 'vitest';
import bundle from '../../dist/cdn/mattebox.hls-ts.min.js?raw';
import { decodesH264, sleep, until } from './harness.js';

// The script-tag bundle as a page loads it, over the TS corpus: the transmux
// ships once in it, runs in a blob Worker, and falls back to the main thread
// when the Worker is blocked, as a strict `worker-src` CSP blocks it.

interface CdnGlobal {
  preset(): {
    attach(video: HTMLVideoElement): Promise<void>;
    load(url: string): void;
    detach(): Promise<void>;
    readonly error: { code: string } | null;
  };
}

function cdnGlobal(): CdnGlobal {
  const scope = globalThis as unknown as { mattebox?: CdnGlobal };
  if (scope.mattebox === undefined) {
    const script = document.createElement('script');
    script.textContent = bundle;
    document.head.appendChild(script);
  }
  return scope.mattebox as CdnGlobal;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function playTs(): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.muted = true;
  document.body.appendChild(video);
  const engine = cdnGlobal().preset();
  cleanups.push(async () => {
    await engine.detach();
    video.remove();
  });
  await engine.attach(video);
  engine.load('/streams/ts/master.m3u8');
  await video.play().catch(() => undefined);
  await until(() => video.currentTime > 2, 'playback past 2 s', 20_000);
  expect(engine.error).toBeNull();
  return video;
}

it.skipIf(!decodesH264)('the script-tag bundle plays TS through its blob Worker', async () => {
  const created: string[] = [];
  let answers = 0;
  const Original = globalThis.Worker;
  globalThis.Worker = class extends Original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      created.push(String(url));
      // A transmuxed segment coming back proves the Worker ran, not the fallback.
      this.addEventListener('message', () => {
        answers += 1;
      });
    }
  };
  cleanups.push(() => {
    globalThis.Worker = Original;
  });
  await playTs();
  expect(created.length).toBeGreaterThan(0);
  expect(created.every((url) => url.startsWith('blob:'))).toBe(true);
  expect(answers).toBeGreaterThan(0);
});

it.skipIf(!decodesH264)('with the Worker blocked, it plays TS on the main thread', async () => {
  const Original = globalThis.Worker;
  let attempts = 0;
  globalThis.Worker = class {
    constructor() {
      attempts += 1;
      throw new DOMException('blocked by worker-src', 'SecurityError');
    }
  } as unknown as typeof Worker;
  cleanups.push(() => {
    globalThis.Worker = Original;
  });
  await playTs();
  expect(attempts).toBeGreaterThan(0);
  await sleep(0);
});
