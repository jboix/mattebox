import { expect, test } from '@playwright/test';

// Tier-4 adaptation tests over a shaped network. The shaping rides the
// transport's fetchImpl seam inside the page; nothing global is patched.

async function boot(page: import('@playwright/test').Page, query: string): Promise<void> {
  await page.goto(`/player.html?src=hls&${query}`);
  await page.waitForFunction(() => window.ready !== undefined);
  await page.evaluate(() => window.ready);
  await page.evaluate(() => void window.video.play());
}

test('8. step-down profile: renditions drop within two segments, no rebuffer', async ({ page }) => {
  test.setTimeout(90_000);
  await boot(page, 'abr=1&profile=step-down');
  // The generous phase first: abr climbs off the lowest rung.
  await page.waitForFunction(
    () => (window.engine.quality.active?.bitrate ?? 0) > 150_000,
    undefined,
    { timeout: 15_000 },
  );
  // After the drop to 250 kbps only the 150 kbps rung is sustainable.
  await page.waitForFunction(() => window.engine.quality.active?.bitrate === 150_000, undefined, {
    timeout: 45_000,
  });
  // Playback never rebuffered: the playhead is still moving.
  const t1 = await page.evaluate(() => window.video.currentTime);
  await page.waitForTimeout(2_000);
  const t2 = await page.evaluate(() => window.video.currentTime);
  expect(t2).toBeGreaterThan(t1 + 1);
});

test('9. sawtooth profile: no oscillation', async ({ page }) => {
  test.setTimeout(90_000);
  await boot(page, 'abr=1&profile=sawtooth');
  await page.waitForTimeout(32_000); // two full sawtooth periods
  const log = await page.evaluate(() => window.switchLog);
  // The first entry is the startup choice, not a switch. Two full periods
  // of flapping bandwidth: tracking the wave costs at most one down-up
  // pair per period, plus a laddered climb; flapping would be dozens.
  expect(log.length - 1).toBeLessThanOrEqual(7);
  const t = await page.evaluate(() => window.video.currentTime);
  expect(t).toBeGreaterThan(20);
});

test('10. collapse and recover: emergency floor, then release', async ({ page }) => {
  test.setTimeout(90_000);
  await boot(page, 'abr=1&profile=collapse');
  // Collapse at 8 s: the emergency source appears; the log survives even a
  // short-lived floor.
  await page.waitForFunction(
    () => window.constraintLog.some((entry) => entry.sources.includes('abr-emergency')),
    undefined,
    { timeout: 45_000 },
  );
  // Recovery: a later snapshot no longer carries the source.
  await page.waitForFunction(
    () => {
      const log = window.constraintLog;
      const hit = log.findIndex((entry) => entry.sources.includes('abr-emergency'));
      return hit >= 0 && log.slice(hit + 1).some((e) => !e.sources.includes('abr-emergency'));
    },
    undefined,
    { timeout: 45_000 },
  );
  // The floor forced a return to the bottom rung after the climb.
  const switched = await page.evaluate(() => window.switchLog.map((s) => s.id));
  const climb = switched.findIndex((id) => id !== 'v-150000');
  expect(climb).toBeGreaterThan(-1);
  expect(switched.slice(climb + 1)).toContain('v-150000');
  const after = await page.evaluate(() => window.engine.quality.allowed.length);
  expect(after).toBe(3);
});

test('11. abr-cap-size: shrinking the element caps the allowed set', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page, 'abr=1&capsize=1');
  await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 10_000 });
  await page.evaluate(() => {
    // The cap is DPR-aware (Desktop Safari emulates a 2x display), so the
    // CSS size that admits only the 180p rung depends on the ratio.
    const dpr = Math.min(devicePixelRatio || 1, 2);
    window.video.style.width = '200px';
    window.video.style.height = `${Math.floor(180 / dpr)}px`;
  });
  await page.waitForFunction(
    () =>
      window.engine.quality.allowed.length === 1 &&
      window.engine.quality.allowed[0]?.height === 180,
    undefined,
    { timeout: 10_000 },
  );
  // The selection follows the cap; the decoded picture follows the buffer.
  await page.waitForFunction(() => window.engine.quality.active?.height === 180, undefined, {
    timeout: 10_000,
  });
  await page.waitForFunction(() => window.engine.quality.playing?.height === 180, undefined, {
    timeout: 30_000,
  });
});

test('12. three constraint sources coexist; releasing one restores only its own', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await boot(page, 'abr=1&capsize=1');
  await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 10_000 });

  await page.evaluate(() => {
    window.engine.quality.constrain('saver', { maxBitrate: 200_000 });
    window.engine.quality.constrain('user', { maxHeight: 300 });
  });
  const stacked = await page.evaluate(() => ({
    sources: [...window.engine.quality.constraints.keys()].sort(),
    allowed: window.engine.quality.allowed.map((r) => r.bitrate),
  }));
  expect(stacked.sources).toEqual(['element-size', 'saver', 'user']);
  expect(stacked.allowed).toEqual([150_000]);

  // Releasing the saver lifts only the saver's exclusions: the user cap
  // still excludes the 360p rung.
  await page.evaluate(() => window.engine.quality.release('saver'));
  const released = await page.evaluate(() => ({
    sources: [...window.engine.quality.constraints.keys()].sort(),
    allowed: window.engine.quality.allowed.map((r) => r.bitrate).sort((a, b) => a - b),
  }));
  expect(released.sources).toEqual(['element-size', 'user']);
  expect(released.allowed).toEqual([150_000, 300_000]);
});
