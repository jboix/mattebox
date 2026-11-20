import { afterEach, describe, expect, it } from 'vitest';
import { boot, disposeAll, play, start, until } from './harness.js';

// DASH with WebM segments through the webm container stage: VP9 video in two
// rungs and Opus audio (gen-streams.sh webm_flavor). A browser whose MSE
// rejects either type skips the file. Playwright's Chromium and Firefox take
// both. WebKit's answer depends on the build: the skip says which.

afterEach(disposeAll);

const decodes =
  MediaSource.isTypeSupported('video/webm; codecs="vp9"') &&
  MediaSource.isTypeSupported('audio/webm; codecs="opus"');

describe.skipIf(!decodes)('DASH WebM', () => {
  it('on demand (SegmentBase with Cues): plays VP9 and Opus from byte ranges', async () => {
    const player = await boot({ src: 'webm' });
    const { engine, video } = player;
    start(player);
    await until(() => video.currentTime > 2, 'currentTime > 2', 5_000);
    expect(engine.error).toBeNull();
    const tracks = engine.tracks.available;
    expect(tracks.filter((t) => t.contentType === 'video')).toHaveLength(1);
    expect(tracks.filter((t) => t.contentType === 'audio')).toHaveLength(1);
    expect(engine.quality.renditions.map((r) => r.height)).toEqual([180, 360]);
    expect(engine.quality.playing?.height).toBe(180);
  });

  it('on demand: a seek to 60 s resumes playback', async () => {
    const player = await boot({ src: 'webm' });
    await play(player, 1, 5_000);
    player.engine.dispatch({ type: 'SEEK', to: 60 });
    await until(
      () => player.video.currentTime > 60.1 && !player.video.seeking,
      'playback past 60 s',
      7_000,
    );
    expect(player.engine.error).toBeNull();
  });

  it('on demand: playback to the end fires ended, the last segment read to the Cues', async () => {
    const player = await boot({ src: 'webm' });
    await play(player, 1, 5_000);
    player.engine.dispatch({ type: 'SEEK', to: player.video.duration - 2 });
    await until(() => player.video.ended, 'ended', 30_000);
    expect(player.engine.error).toBeNull();
  });

  it('on demand: a switch to the upper rung plays it', async () => {
    const player = await boot({ src: 'webm' });
    await play(player, 1, 5_000);
    const top = player.engine.quality.renditions.find((r) => r.height === 360);
    player.engine.quality.pin(top?.id as string, { apply: 'now' });
    await until(() => player.engine.quality.playing?.height === 360, 'playing 360p', 10_000);
    const t = player.video.currentTime;
    await until(() => player.video.currentTime > t + 2, 'playback goes on', 5_000);
    expect(player.engine.error).toBeNull();
  });

  it('SegmentTemplate: plays WebM chunks from the MPD alone', async () => {
    const player = await boot({ src: 'webm-template' });
    start(player);
    await until(() => player.video.currentTime > 2, 'currentTime > 2', 5_000);
    expect(player.engine.error).toBeNull();
    expect(player.engine.quality.playing?.codecs).toMatch(/^vp09/);
  });
});
