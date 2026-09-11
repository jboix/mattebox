import { afterEach, expect, it } from 'vitest';
import { boot, disposeAll, play, sleep, start, until } from './harness.js';

// Streams with no end: the fixture server slides a window over the
// generated segments, anchored at boot time. The HLS edge is read from
// the playlist; the DASH edge is computed from the clock.

afterEach(disposeAll);

it('17. hls live plays continuously and the window slides', async () => {
  const player = await boot({ src: 'hls-live' });
  await play(player, 1, 15_000);
  const { engine, video } = player;
  const early = { t: video.currentTime, edge: engine.live?.edge ?? null };
  expect(early.edge).not.toBeNull();
  await sleep(12_000);
  // Playback kept pace with the sliding window: the playhead advanced in
  // real time, the edge moved, and latency stayed inside the hold-back.
  expect(video.currentTime).toBeGreaterThan(early.t + 10);
  expect(engine.live?.edge as number).toBeGreaterThan(early.edge as number);
  expect(engine.live?.latency as number).toBeLessThan(8);
  expect(engine.error?.code ?? null).toBeNull();
});

it('18. dash live plays with a computed window', async () => {
  const player = await boot({ src: 'dash-live' });
  await play(player, 1, 20_000);
  await sleep(10_000);
  expect(player.video.currentTime).toBeGreaterThan(9);
  expect(player.engine.live?.edge ?? null).not.toBeNull();
  expect(player.engine.error?.code ?? null).toBeNull();
});

it('19. seekToEdge lands within the hold-back', async () => {
  const player = await boot({ src: 'hls-live' });
  await play(player, 1, 15_000);
  const { engine, video } = player;
  // Fall behind on purpose, then jump.
  video.pause();
  await sleep(9_000);
  start(player);
  engine.live?.seekToEdge();
  await until(
    () => {
      const edge = engine.live?.edge ?? null;
      return edge !== null && Math.abs(video.currentTime - edge) < 3;
    },
    'playhead within 3 s of the edge',
    15_000,
  );
  expect(engine.live?.atEdge ?? false).toBe(true);
});
