import { expect, test } from '@playwright/test';

// Streams with no end: the local simulator slides a window over the
// generated segments, anchored at page-load time. The HLS edge is read
// from the playlist; the DASH edge is computed from the clock.

async function boot(page: import('@playwright/test').Page, src: string): Promise<void> {
  await page.goto(`/player.html?src=${src}`);
  await page.waitForFunction(() => window.ready !== undefined);
  await page.evaluate(() => window.ready);
  await page.evaluate(() => void window.video.play());
}

test('17. hls live plays continuously and the window slides', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page, 'hls-live');
  await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 15_000 });
  const early = await page.evaluate(() => ({
    t: window.video.currentTime,
    edge: window.engine.live?.edge ?? null,
  }));
  expect(early.edge).not.toBeNull();
  await page.waitForTimeout(12_000);
  const later = await page.evaluate(() => ({
    t: window.video.currentTime,
    edge: window.engine.live?.edge ?? null,
    latency: window.engine.live?.latency ?? null,
    error: window.engine.error?.code ?? null,
  }));
  // Playback kept pace with the sliding window: the playhead advanced in
  // real time, the edge moved, and latency stayed inside the hold-back.
  expect(later.t).toBeGreaterThan(early.t + 10);
  expect(later.edge as number).toBeGreaterThan(early.edge as number);
  expect(later.latency as number).toBeLessThan(8);
  expect(later.error).toBeNull();
});

test('18. dash live plays with a computed window', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page, 'dash-live');
  await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 20_000 });
  await page.waitForTimeout(10_000);
  const state = await page.evaluate(() => ({
    t: window.video.currentTime,
    edge: window.engine.live?.edge ?? null,
    error: window.engine.error?.code ?? null,
  }));
  expect(state.t).toBeGreaterThan(9);
  expect(state.edge).not.toBeNull();
  expect(state.error).toBeNull();
});

test('19. seekToEdge lands within the hold-back', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page, 'hls-live');
  await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 15_000 });
  // Fall behind on purpose, then jump.
  await page.evaluate(() => window.video.pause());
  await page.waitForTimeout(9_000);
  await page.evaluate(() => {
    void window.video.play();
    window.engine.live?.seekToEdge();
  });
  await page.waitForFunction(
    () => {
      const edge = window.engine.live?.edge ?? null;
      return edge !== null && Math.abs(window.video.currentTime - edge) < 3;
    },
    undefined,
    { timeout: 15_000 },
  );
  const atEdge = await page.evaluate(() => window.engine.live?.atEdge ?? false);
  expect(atEdge).toBe(true);
});
