import { afterEach, expect, it } from 'vitest';
import type { Player } from './harness.js';
import { boot, disposeAll, encryptedEvent, hasEme, play, sleep } from './harness.js';

// DRM through eme-core with real EME APIs. ffmpeg cannot encrypt fmp4
// HLS/DASH segments (only the raw fragmented-mp4 muxer), so encrypted
// decode-playback is a registered tooling gap. What runs here is the full
// eme-core flow against the browser's own EME: key-system negotiation, a
// session, the ClearKey license applied locally, and a usable key status.
// The license path is exercised by driving an `encrypted` event with a
// real keyids init, which produces a real ClearKey message eme-core
// answers from its configured keys.

afterEach(disposeAll);

const KID = 'nrQFDeRLSAKTLifXUIPiZg';

// A real keyids init: JSON { kids: [base64url kid] }. Dispatching an
// `encrypted` event with it is exactly what MSE does for keyids content,
// so eme-core runs its true media-route flow.
function dispatchEncrypted(player: Player): void {
  const initData = new TextEncoder().encode(JSON.stringify({ kids: [KID] })).buffer;
  player.video.dispatchEvent(encryptedEvent('keyids', initData));
}

async function waitForUsable(player: Player): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const usable = player.engine.drm?.sessions.some(
      (s) => s.keyId === KID && s.status === 'usable',
    );
    if (usable === true) return;
    await sleep(250);
  }
}

it('28. clear content still plays with eme-core loaded', async () => {
  const player = await boot({ src: 'hls', drm: true });
  await play(player, 1, 15_000);
  expect('drm' in player.engine).toBe(true);
  expect(player.engine.error?.code ?? null).toBeNull();
});

it.skipIf(!hasEme)(
  '29. an encrypted event drives key-system negotiation and a usable license',
  async () => {
    const player = await boot({ src: 'hls', drm: true });
    dispatchEncrypted(player);
    await waitForUsable(player);
    const drm = player.engine.drm;
    const session = drm?.sessions.find((s) => s.keyId === KID);
    expect(drm?.keySystem ?? null).toBe('org.w3.clearkey');
    expect(session?.status).toBe('usable');
  },
);

it.skipIf(!hasEme)('30. two encrypted events for the same key open one session', async () => {
  const player = await boot({ src: 'hls', drm: true });
  dispatchEncrypted(player);
  dispatchEncrypted(player);
  await waitForUsable(player);
  // Dedup keys sessions by key id: one entry for the one key.
  const sessions = (player.engine.drm?.sessions ?? []).filter((s) => s.keyId === KID);
  expect(sessions.length).toBe(1);
});
