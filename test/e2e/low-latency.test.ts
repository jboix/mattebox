import { afterEach, beforeEach, expect, it } from 'vitest';
import { boot, disposeAll, gesture, play, sleep, until } from './harness.js';

// Low-latency HLS. The local origin (fixture-server.ts) publishes a 1 s part
// every second, holds blocking playlist reloads and preload hints, and
// answers delta updates. PART-HOLD-BACK is 3 s.

afterEach(disposeAll);

// Catch-up changes the playback rate only after a user interaction.
beforeEach(gesture);

/** Requests the page made whose URL contains `needle`. */
function requested(needle: string): string[] {
  return performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => name.includes(needle));
}

it('53. LL-HLS plays from parts and holds a latency near PART-HOLD-BACK', async () => {
  performance.clearResourceTimings();
  const player = await boot({ src: 'hls-ll' });
  await play(player, 1, 20_000);
  await sleep(15_000);
  const { engine } = player;
  const latency = engine.catchup?.latency ?? Number.POSITIVE_INFINITY;
  expect(engine.catchup?.target).toBe(3);
  expect(latency).toBeGreaterThan(1.5);
  expect(latency).toBeLessThan(4.5);
  expect(engine.live?.latency as number).toBeLessThan(5);
  // Parts, blocking reloads, and delta updates, not whole segments on a timer.
  expect(requested('/part-').length).toBeGreaterThan(10);
  expect(requested('_HLS_msn=').length).toBeGreaterThan(10);
  expect(engine.error?.code ?? null).toBeNull();
});

it('54. catch-up moves the latency to a new target with the playback rate', async () => {
  const player = await boot({ src: 'hls-ll' });
  await play(player, 1, 20_000);
  await sleep(4_000);
  const { engine, video } = player;
  const before = engine.catchup?.latency as number;
  engine.catchup?.setTarget(6);
  await until(() => video.playbackRate < 1, 'a slower rate', 5_000);
  await sleep(10_000);
  // At 0.96 for 10 s the playhead falls about 0.4 s further behind.
  expect(engine.catchup?.latency as number).toBeGreaterThan(before + 0.2);
  engine.catchup?.setTarget(null);
  await until(() => video.playbackRate > 1, 'a faster rate', 5_000);
});

it('55. hls-ll plays a live playlist without parts as hls-live does', async () => {
  const player = await boot({ src: 'hls-live', ll: true });
  await play(player, 1, 15_000);
  await sleep(10_000);
  const { engine, video } = player;
  expect(video.currentTime).toBeGreaterThan(9);
  expect(engine.live?.latency as number).toBeLessThan(8);
  expect(engine.error?.code ?? null).toBeNull();
});

const decodesMux = MediaSource.isTypeSupported('video/mp4; codecs="avc1.640020,mp4a.40.2"');

it.skipIf(!decodesMux)('56. a public LL-HLS stream plays at low latency', async () => {
  const player = await boot({ src: 'mux-ll' });
  await play(player, 1, 30_000);
  await sleep(12_000);
  const { engine } = player;
  // Mux: PART-HOLD-BACK 2.171 s, 1 s parts.
  expect(engine.catchup?.latency as number).toBeLessThan(5);
  expect(engine.error?.code ?? null).toBeNull();
});
