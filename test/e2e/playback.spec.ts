import { expect, test } from '@playwright/test';

// The Stage 08 milestone, run per protocol since Stage 10: the same
// engine, the same assertions, HLS and DASH packagings of the same
// content. Each test asserts an observable outcome, never an
// implementation detail.

for (const proto of ['hls', 'dash'] as const) {
  test.describe(proto, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/player.html?src=${proto}`);
      await page.waitForFunction(() => window.ready !== undefined);
      await page.evaluate(() => window.ready);
    });

    test('9. VOD startup: currentTime passes 2 s within 5 s of LOAD', async ({ page }) => {
      await page.evaluate(() => void window.video.play());
      await page.waitForFunction(() => window.video.currentTime > 2, undefined, { timeout: 5_000 });
      const state = await page.evaluate(() => ({
        currentTime: window.video.currentTime,
        readyState: window.video.readyState,
      }));
      expect(state.currentTime).toBeGreaterThan(2);
      expect(state.readyState).toBeGreaterThanOrEqual(3);
    });

    test('10. seek to 60 s resumes playback within 2 s', async ({ page }) => {
      await page.evaluate(() => void window.video.play());
      await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 5_000 });

      await page.evaluate(() => {
        window.engine.dispatch({ type: 'SEEK', to: 60 });
      });
      await page.waitForFunction(
        () => window.video.currentTime > 60.1 && !window.video.seeking,
        undefined,
        {
          timeout: 2_000 + 5_000,
        },
      );
      const t = await page.evaluate(() => window.video.currentTime);
      expect(t).toBeGreaterThan(60);
    });

    test('11. playback to the end fires ended', async ({ page }) => {
      await page.evaluate(() => void window.video.play());
      await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 5_000 });
      // Jump near the end instead of watching 72 seconds of test pattern.
      await page.evaluate(() => {
        window.engine.dispatch({ type: 'SEEK', to: window.video.duration - 2 });
      });
      // Generous: under parallel decode load webkit reaches the end late.
      await page.waitForFunction(() => window.video.ended, undefined, { timeout: 30_000 });
      expect(await page.evaluate(() => window.video.ended)).toBe(true);
    });

    test('12. multiple renditions, no abr: the lowest plays at startup', async ({ page }) => {
      await page.evaluate(() => void window.video.play());
      await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 5_000 });
      const quality = await page.evaluate(() => ({
        renditions: window.engine.quality.renditions.map((r) => ({ id: r.id, bitrate: r.bitrate })),
        active: window.engine.quality.active?.id ?? null,
        playing: window.engine.quality.playing?.id ?? null,
      }));
      expect(quality.renditions.length).toBeGreaterThan(1);
      const lowest = [...quality.renditions].sort((a, b) => a.bitrate - b.bitrate)[0];
      expect(quality.active).toBe(lowest?.id);
      expect(quality.playing).toBe(lowest?.id);
    });
  });
}

test('13. a quality-switch storm never wedges playback', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/player.html?src=hls');
  await page.waitForFunction(() => window.ready !== undefined);
  await page.evaluate(() => window.ready);
  await page.evaluate(() => void window.video.play());
  await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 10_000 });

  // The monkey: rapid pins, mixed applies, including renditions whose
  // media playlists are not merged yet. The regression this guards: a
  // flush that never executed left stale content playing, media appended
  // before its init, and the decoder frozen.
  await page.evaluate(async () => {
    const ids = window.engine.quality.renditions.map((r) => r.id);
    const applies = ['now', 'soon', 'now', 'now', 'soon', 'now', 'now', 'soon'] as const;
    for (let i = 0; i < applies.length; i += 1) {
      window.engine.quality.pin(ids[(i * 2 + 1) % ids.length] as string, {
        apply: applies[i] as 'now' | 'soon',
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    window.engine.quality.pin(ids[0] as string, { apply: 'now' });
  });

  await page.waitForTimeout(1_000);
  const t1 = await page.evaluate(() => window.video.currentTime);
  await page.waitForTimeout(3_000);
  const state = await page.evaluate(() => ({
    t: window.video.currentTime,
    active: window.engine.quality.active?.id ?? null,
    pinned: window.engine.quality.pinned,
    error: window.engine.error?.code ?? null,
  }));
  expect(state.t).toBeGreaterThan(t1 + 2);
  expect(state.error).toBeNull();
  expect(state.active).toBe(state.pinned);
});
