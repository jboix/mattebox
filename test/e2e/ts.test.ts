import { afterEach, describe, expect, it } from 'vitest';
import { boot, decodesH264, disposeAll, play, until } from './harness.js';

// Stage 17: the legacy MPEG-TS family. The playground's oldest wound was
// Apple's bipbop stream turning into an infinite refetch loop, which Stage 11
// made a clean fatal. Here it simply plays: the .ts segments transmux to fMP4
// through the transform pipeline and reach the SourceBuffer as video/mp4.
//
// The content is H.264, which Playwright's Chromium cannot decode, so these
// run on Firefox and WebKit. The transmux itself is codec-agnostic and its
// output is proven byte-for-byte by the Node golden tests on all platforms.

afterEach(disposeAll);

describe.skipIf(!decodesH264)('muxed MPEG-TS', () => {
  it('40. a muxed .ts stream plays: the Stage 09/11 fatal becomes playback', async () => {
    const player = await boot({ src: 'ts' });
    await play(player, 2, 15_000);
    const { engine, video } = player;
    expect(engine.error?.code ?? null).toBeNull();
    expect(video.currentTime).toBeGreaterThan(2);
    // readyState >= 3 means both the transmuxed video and audio are decoding.
    expect(video.readyState).toBeGreaterThanOrEqual(3);
    // videoWidth > 0 proves the video track actually decoded, not just audio:
    // the Main-profile B-frame reorder must be right or this stays zero.
    expect(video.videoWidth).toBeGreaterThan(0);
  });

  it('41. the transmux Worker chunk loads, not only the fallback', async () => {
    // The previous test's fetches are not this engine's.
    performance.clearResourceTimings();
    const player = await boot({ src: 'ts' });
    await play(player, 1, 15_000);
    // The Worker is its own served module; if the browser fetched it, the
    // real Worker path ran. A 404 would silently take the main-thread fallback.
    const workerFetched = performance
      .getEntriesByType('resource')
      .some((e) => e.name.includes('transmux.worker.js'));
    expect(workerFetched).toBe(true);
  });

  it('42. a mid-stream seek into TS content resumes cleanly', async () => {
    const player = await boot({ src: 'ts' });
    await play(player, 1, 15_000);
    player.engine.dispatch({ type: 'SEEK', to: 30 });
    await until(
      () => player.video.currentTime > 30.1 && !player.video.seeking,
      'playback past 30 s',
      15_000,
    );
    expect(player.video.currentTime).toBeGreaterThan(30);
  });
});
