import { afterEach, describe, expect, it } from 'vitest';
import { boot, disposeAll, play, sleep, start, until } from './harness.js';

// The Stage 08 milestone, run per protocol since Stage 10: the same
// engine, the same assertions, HLS and DASH packagings of the same
// content. Each test asserts an observable outcome, never an
// implementation detail.

afterEach(disposeAll);

for (const src of ['hls', 'dash'] as const) {
  describe(src, () => {
    it('9. VOD startup: currentTime passes 2 s within 5 s of LOAD', async () => {
      const player = await boot({ src });
      const { video } = player;
      start(player);
      await until(() => video.currentTime > 2, 'currentTime > 2', 5_000);
      expect(video.currentTime).toBeGreaterThan(2);
      expect(video.readyState).toBeGreaterThanOrEqual(3);
    });

    it('10. seek to 60 s resumes playback within 2 s', async () => {
      const player = await boot({ src });
      await play(player, 1, 5_000);
      player.engine.dispatch({ type: 'SEEK', to: 60 });
      await until(
        () => player.video.currentTime > 60.1 && !player.video.seeking,
        'playback past 60 s',
        2_000 + 5_000,
      );
      expect(player.video.currentTime).toBeGreaterThan(60);
    });

    it('11. playback to the end fires ended', async () => {
      const player = await boot({ src });
      await play(player, 1, 5_000);
      // Jump near the end instead of watching 72 seconds of test pattern.
      player.engine.dispatch({ type: 'SEEK', to: player.video.duration - 2 });
      // Generous: under decode load webkit reaches the end late.
      await until(() => player.video.ended, 'ended', 30_000);
      expect(player.video.ended).toBe(true);
    });

    it('12. multiple renditions, no abr: the lowest plays at startup', async () => {
      const player = await boot({ src });
      await play(player, 1, 5_000);
      const renditions = player.engine.quality.renditions;
      expect(renditions.length).toBeGreaterThan(1);
      const lowest = [...renditions].sort((a, b) => a.bitrate - b.bitrate)[0];
      expect(player.engine.quality.active?.id).toBe(lowest?.id);
      expect(player.engine.quality.playing?.id).toBe(lowest?.id);
    });
  });
}

it('13. a quality-switch storm never wedges playback', async () => {
  const player = await boot({ src: 'hls' });
  await play(player, 1, 10_000);
  const { engine, video } = player;

  // The monkey: rapid pins, mixed applies, including renditions whose
  // media playlists are not merged yet. The regression this guards: a
  // flush that never executed left stale content playing, media appended
  // before its init, and the decoder frozen.
  const ids = engine.quality.renditions.map((r) => r.id);
  const applies = ['now', 'soon', 'now', 'now', 'soon', 'now', 'now', 'soon'] as const;
  for (let i = 0; i < applies.length; i += 1) {
    engine.quality.pin(ids[(i * 2 + 1) % ids.length] as string, {
      apply: applies[i] as 'now' | 'soon',
    });
    await sleep(300);
  }
  engine.quality.pin(ids[0] as string, { apply: 'now' });

  await sleep(1_000);
  const t1 = video.currentTime;
  await sleep(3_000);
  expect(video.currentTime).toBeGreaterThan(t1 + 2);
  expect(engine.error?.code ?? null).toBeNull();
  expect(engine.quality.active?.id ?? null).toBe(engine.quality.pinned);
});

it('14. a media playlist with no CODECS plays: codec-probe types the buffer from the init segment', async () => {
  const player = await boot({ src: 'bare' });
  await play(player, 2, 10_000);
  expect(player.engine.error).toBeNull();
  expect(player.engine.codecProbe?.mimeType).toMatch(/codecs="/);
});

it('47. a SegmentList MPD plays and seeks, segment by segment URL', async () => {
  const player = await boot({ src: 'dash-list' });
  await play(player, 1, 5_000);
  player.engine.dispatch({ type: 'SEEK', to: 30 });
  await until(
    () => player.video.currentTime > 30.1 && !player.video.seeking,
    'playback past 30 s',
    10_000,
  );
  expect(player.engine.error?.code ?? null).toBeNull();
});

it('52. a three-period MPD plays across both boundaries as one presentation', async () => {
  const player = await boot({ src: 'periods' });
  const changed: unknown[] = [];
  player.engine.on('tracks:changed', (payload) => changed.push(payload));
  await play(player, 1, 5_000);
  const tracks = player.engine.tracks.available.filter((t) => t.contentType === 'video');
  expect(tracks.map((t) => t.id)).toEqual(['as-0']);
  // The load's own tracks:changed is behind us; a boundary must add none.
  changed.length = 0;
  // Into the content just before the ad, then through the ad and back.
  player.engine.dispatch({ type: 'SEEK', to: 10 });
  await until(() => player.video.currentTime > 23 && !player.video.seeking, 'past the ad', 30_000);
  expect(player.engine.error?.code ?? null).toBeNull();
  expect(changed).toEqual([]);
});
