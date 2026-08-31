import { expect, test } from '@playwright/test';

// Stage 17: the legacy MPEG-TS family. The playground's oldest wound was
// Apple's bipbop stream turning into an infinite refetch loop, which Stage 11
// made a clean fatal. Here it simply plays: the .ts segments transmux to fMP4
// through the transform pipeline and reach the SourceBuffer as video/mp4.
//
// The content is H.264, which Playwright's Chromium cannot decode, so these
// run on Firefox and WebKit. The transmux itself is codec-agnostic and its
// output is proven byte-for-byte by the Node golden tests on all platforms.

test.describe('muxed MPEG-TS', () => {
  test.skip(
    ({ browserName }) => browserName === 'chromium',
    'Chromium ships no H.264 decoder; the TS content is H.264',
  );

  test.beforeEach(async ({ page }) => {
    await page.goto('/player.html?src=ts');
    await page.waitForFunction(() => window.ready !== undefined);
    await page.evaluate(() => window.ready);
  });

  test('40. a muxed .ts stream plays: the Stage 09/11 fatal becomes playback', async ({ page }) => {
    await page.evaluate(() => void window.video.play());
    await page.waitForFunction(() => window.video.currentTime > 2, undefined, { timeout: 15_000 });
    const state = await page.evaluate(() => ({
      currentTime: window.video.currentTime,
      readyState: window.video.readyState,
      videoWidth: window.video.videoWidth,
      error: window.engine.error?.code ?? null,
    }));
    expect(state.error).toBeNull();
    expect(state.currentTime).toBeGreaterThan(2);
    // readyState >= 3 means both the transmuxed video and audio are decoding.
    expect(state.readyState).toBeGreaterThanOrEqual(3);
    // videoWidth > 0 proves the video track actually decoded, not just audio:
    // the Main-profile B-frame reorder must be right or this stays zero.
    expect(state.videoWidth).toBeGreaterThan(0);
  });

  test('41. the transmux Worker chunk loads, not only the fallback', async ({ page }) => {
    await page.evaluate(() => void window.video.play());
    await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 15_000 });
    // The Worker is its own served chunk; if the browser fetched it, the real
    // Worker path ran. A 404 here would silently take the main-thread fallback.
    const workerFetched = await page.evaluate(() =>
      performance.getEntriesByType('resource').some((e) => e.name.includes('transmux.worker.js')),
    );
    expect(workerFetched).toBe(true);
  });

  test('42. a mid-stream seek into TS content resumes cleanly', async ({ page }) => {
    await page.evaluate(() => void window.video.play());
    await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 15_000 });
    await page.evaluate(() => window.engine.dispatch({ type: 'SEEK', to: 30 }));
    await page.waitForFunction(
      () => window.video.currentTime > 30.1 && !window.video.seeking,
      undefined,
      {
        timeout: 15_000,
      },
    );
    expect(await page.evaluate(() => window.video.currentTime)).toBeGreaterThan(30);
  });
});
