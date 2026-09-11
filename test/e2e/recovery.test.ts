import { afterEach, expect, it } from 'vitest';
import { boot, disposeAll, play, traceEvents, until } from './harness.js';

// The injected-failure suite: the escalation ladder under real playback.
// Failures inject through the transport's fetchImpl seam or the steering
// pathway routes; nothing global is patched.

afterEach(disposeAll);

it('20. one bad rendition mid-stream: playback continues on another', async () => {
  // The lowest rung starts 404ing after 4 s; no abr is loaded, so only
  // recovery's exclusion can move playback off it.
  const player = await boot({ src: 'hls', fail: 'seg-low', failAfter: 4 });
  await play(player, 1, 15_000);
  const { engine, video } = player;
  await until(
    () => engine.quality.active !== null && engine.quality.active.id !== 'v-150000',
    'a move off the bad rung',
    30_000,
  );
  // Playback survives well past the failure point.
  await until(() => video.currentTime > 20, 'currentTime > 20', 30_000);
  expect(engine.error?.code ?? null).toBeNull();
  expect(engine.quality.active?.id ?? null).not.toBe('v-150000');
  expect(traceEvents(player)).toContain('recovery:excluded');
}, 90_000);

it('21. a hole in the content is seeked over', async () => {
  // Segment 3 ([12, 16)) is missing from every rendition.
  const player = await boot({ src: 'hls', fail: '-003.m4s' });
  await play(player, 1, 15_000);
  // Recovery seeks over the hole rather than dying on it.
  await until(() => traceEvents(player).includes('recovery:skip'), 'recovery:skip', 45_000);
  // Playback continues into the post-hole region (segment 4 starts at 16).
  await until(() => player.video.currentTime > 13, 'currentTime > 13', 30_000);
  expect(player.engine.error?.code ?? null).toBeNull();
}, 90_000);

it('22. steering fails over to the next pathway', async () => {
  // Pathway a serves only segments 0..2; the steering stage must move to b.
  const player = await boot({ src: 'steer' });
  await play(player, 1, 15_000);
  await until(() => player.video.currentTime > 16, 'currentTime > 16', 45_000);
  expect(player.engine.error?.code ?? null).toBeNull();
  expect(player.engine.quality.active?.id ?? null).toBe('v-150000-b');
  expect(traceEvents(player)).toContain('steering:failover');
}, 90_000);

it('23. when everything dies, recovery escalates and the breaker still ends it', async () => {
  const player = await boot({ src: 'hls', fail: '.m4s', failAfter: 4 });
  await play(player, 1, 15_000);
  await until(() => player.engine.error !== null, 'a fatal error', 60_000);
  // The ladder ran before the end: exclusions first, the fatal last.
  expect(traceEvents(player)).toContain('recovery:excluded');
  expect(player.engine.error?.code ?? null).not.toBeNull();
}, 90_000);
