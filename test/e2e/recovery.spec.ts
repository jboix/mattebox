import { expect, test } from '@playwright/test';

// The injected-failure suite: the escalation ladder under real playback.
// Failures inject through the transport's fetchImpl seam or the steering
// pathway routes; nothing global is patched.

async function boot(page: import('@playwright/test').Page, query: string): Promise<void> {
  await page.goto(`/player.html?${query}`);
  await page.waitForFunction(() => window.ready !== undefined);
  await page.evaluate(() => window.ready);
  await page.evaluate(() => void window.video.play());
  await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 15_000 });
}

function traceEvents(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() =>
    window.engine.stats
      .trace()
      .flatMap((e) => e.effects)
      .filter((f) => f.kind === 'emit')
      .map((f) => (f as { event: string }).event),
  );
}

test('20. one bad rendition mid-stream: playback continues on another', async ({ page }) => {
  test.setTimeout(90_000);
  // The lowest rung starts 404ing after 4 s; no abr is loaded, so only
  // recovery's exclusion can move playback off it.
  await boot(page, 'src=hls&fail=seg-low&failAfter=4');
  await page.waitForFunction(
    () => window.engine.quality.active !== null && window.engine.quality.active.id !== 'v-150000',
    undefined,
    { timeout: 30_000 },
  );
  // Playback survives well past the failure point.
  await page.waitForFunction(() => window.video.currentTime > 20, undefined, { timeout: 30_000 });
  const state = await page.evaluate(() => ({
    error: window.engine.error?.code ?? null,
    active: window.engine.quality.active?.id ?? null,
  }));
  expect(state.error).toBeNull();
  expect(state.active).not.toBe('v-150000');
  expect(await traceEvents(page)).toContain('recovery:excluded');
});

test('21. a hole in the content is seeked over', async ({ page }) => {
  test.setTimeout(90_000);
  // Segment 3 ([12, 16)) is missing from every rendition.
  await boot(page, 'src=hls&fail=-003.m4s');
  // Recovery seeks over the hole rather than dying on it.
  await page.waitForFunction(
    () =>
      window.engine.stats
        .trace()
        .flatMap((e) => e.effects)
        .some((f) => f.kind === 'emit' && (f as { event: string }).event === 'recovery:skip'),
    undefined,
    { timeout: 45_000 },
  );
  // Playback continues into the post-hole region (segment 4 starts at 16).
  await page.waitForFunction(() => window.video.currentTime > 13, undefined, { timeout: 30_000 });
  const error = await page.evaluate(() => window.engine.error?.code ?? null);
  expect(error).toBeNull();
});

test('22. steering fails over to the next pathway', async ({ page }) => {
  test.setTimeout(90_000);
  // Pathway a serves only segments 0..2; the steering stage must move to b.
  await boot(page, 'src=steer');
  await page.waitForFunction(() => window.video.currentTime > 16, undefined, { timeout: 45_000 });
  const state = await page.evaluate(() => ({
    active: window.engine.quality.active?.id ?? null,
    error: window.engine.error?.code ?? null,
  }));
  expect(state.error).toBeNull();
  expect(state.active).toBe('v-150000-b');
  const events = await traceEvents(page);
  expect(events).toContain('steering:failover');
});

test('23. when everything dies, recovery escalates and the breaker still ends it', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await boot(page, 'src=hls&fail=.m4s&failAfter=4');
  await page.waitForFunction(() => window.engine.error !== null, undefined, { timeout: 60_000 });
  const events = await traceEvents(page);
  // The ladder ran before the end: exclusions first, the fatal last.
  expect(events).toContain('recovery:excluded');
  const error = await page.evaluate(() => window.engine.error?.code ?? null);
  expect(error).not.toBeNull();
});
