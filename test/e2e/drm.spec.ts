import { expect, test } from '@playwright/test';

// DRM through eme-core with real EME APIs. ffmpeg cannot encrypt fmp4
// HLS/DASH segments (only the raw fragmented-mp4 muxer), so encrypted
// decode-playback is a registered tooling gap. What runs here is the full
// eme-core flow against the browser's own EME: key-system negotiation, a
// session, the ClearKey license applied locally, and a usable key status.
// The license path is exercised by driving an `encrypted` event with a
// real keyids init, which produces a real ClearKey message eme-core
// answers from its configured keys.

async function bootDrm(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/player.html?src=hls&drm=1');
  await page.waitForFunction(() => window.ready !== undefined);
  await page.evaluate(() => window.ready);
}

/** Skips where the browser build has no EME: Playwright's WebKit on Linux ships none. */
async function requireEme(page: import('@playwright/test').Page): Promise<void> {
  const hasEme = await page.evaluate(() => 'requestMediaKeySystemAccess' in navigator);
  test.skip(!hasEme, 'this browser build has no Encrypted Media Extensions');
}

const KID = 'nrQFDeRLSAKTLifXUIPiZg';

test('28. clear content still plays with eme-core loaded', async ({ page }) => {
  test.setTimeout(60_000);
  await bootDrm(page);
  await page.evaluate(() => void window.video.play());
  await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 15_000 });
  const state = await page.evaluate(() => ({
    t: window.video.currentTime,
    hasDrm: 'drm' in window.engine,
    error: window.engine.error?.code ?? null,
  }));
  expect(state.hasDrm).toBe(true);
  expect(state.error).toBeNull();
});

test('29. an encrypted event drives key-system negotiation and a usable license', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await bootDrm(page);
  await requireEme(page);
  const result = await page.evaluate(async (kid) => {
    // A real keyids init: JSON { kids: [base64url kid] }. Dispatching an
    // `encrypted` event with it is exactly what MSE does for keyids content,
    // so eme-core runs its true media-route flow.
    const initJson = JSON.stringify({ kids: [kid] });
    const initData = new TextEncoder().encode(initJson).buffer;
    window.video.dispatchEvent(window.encryptedEvent('keyids', initData));
    // Wait for the session to reach a usable key status.
    const drm = window.engine.drm;
    for (let i = 0; i < 60; i += 1) {
      const usable = drm?.sessions.find((s) => s.keyId === kid && s.status === 'usable');
      if (usable !== undefined) {
        return { keySystem: drm?.keySystem ?? null, status: usable.status };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return {
      keySystem: drm?.keySystem ?? null,
      status: drm?.sessions.map((s) => `${s.keyId}:${s.status}`).join(',') ?? 'none',
    };
  }, KID);
  expect(result.keySystem).toBe('org.w3.clearkey');
  expect(result.status).toBe('usable');
});

test('30. two encrypted events for the same key open one session', async ({ page }) => {
  test.setTimeout(60_000);
  await bootDrm(page);
  await requireEme(page);
  const sessionCount = await page.evaluate(async (kid) => {
    const dispatch = () => {
      const initData = new TextEncoder().encode(JSON.stringify({ kids: [kid] })).buffer;
      window.video.dispatchEvent(window.encryptedEvent('keyids', initData));
    };
    dispatch();
    dispatch();
    // Wait for the key to become usable, then count distinct sessions.
    for (let i = 0; i < 60; i += 1) {
      const usable = window.engine.drm?.sessions.filter((s) => s.status === 'usable') ?? [];
      if (usable.length > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // Dedup keys sessions by key id: one entry for the one key.
    return (window.engine.drm?.sessions ?? []).filter((s) => s.keyId === kid).length;
  }, KID);
  expect(sessionCount).toBe(1);
});
