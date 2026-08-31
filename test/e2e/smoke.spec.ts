import { expect, test } from '@playwright/test';

// Tier 4 wiring proof — real playback E2E arrives once the engine can play media.
test('drives a page with a media element', async ({ page }) => {
  await page.setContent('<video id="v" muted></video>');
  await expect(page.locator('#v')).toBeAttached();
  const readyState = await page.locator('#v').evaluate((el) => (el as HTMLVideoElement).readyState);
  expect(readyState).toBe(0);
});
