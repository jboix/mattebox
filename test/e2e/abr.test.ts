import { afterEach, expect, it } from 'vitest';
import { boot, disposeAll, play, sleep, start, until } from './harness.js';

// Tier-4 adaptation tests over a shaped network. The shaping rides the
// transport's fetchImpl seam inside the harness; nothing global is patched.

afterEach(disposeAll);

it('8. step-down profile: renditions drop within two segments, no rebuffer', async () => {
  const player = await boot({ abr: true, profile: 'step-down' });
  const { engine, video } = player;
  start(player);
  // The generous phase first: abr climbs off the lowest rung.
  await until(() => (engine.quality.active?.bitrate ?? 0) > 150_000, 'a climb', 15_000);
  // After the drop to 250 kbps only the 150 kbps rung is sustainable.
  await until(() => engine.quality.active?.bitrate === 150_000, 'the drop', 45_000);
  // Playback never rebuffered: the playhead is still moving.
  const t1 = video.currentTime;
  await sleep(2_000);
  expect(video.currentTime).toBeGreaterThan(t1 + 1);
}, 90_000);

it('9. sawtooth profile: no oscillation', async () => {
  const player = await boot({ abr: true, profile: 'sawtooth' });
  const { video, switchLog } = player;
  start(player);
  await sleep(32_000); // two full sawtooth periods
  // The first entry is the startup choice, not a switch. Two full periods
  // of flapping bandwidth: tracking the wave costs at most one down-up
  // pair per period, plus a laddered climb; flapping would be dozens.
  expect(switchLog.length - 1).toBeLessThanOrEqual(7);
  expect(video.currentTime).toBeGreaterThan(20);
}, 90_000);

it('10. collapse and recover: emergency floor, then release', async () => {
  const player = await boot({ abr: true, profile: 'collapse' });
  const { engine, switchLog, constraintLog } = player;
  start(player);
  const floored = (entry: { sources: string[] }) => entry.sources.includes('abr-emergency');
  // Collapse at 8 s: the emergency source appears; the log survives even a
  // short-lived floor.
  await until(() => constraintLog.some(floored), 'the emergency floor', 45_000);
  // Recovery: a later snapshot no longer carries the source.
  await until(
    () => {
      const hit = constraintLog.findIndex(floored);
      return hit >= 0 && constraintLog.slice(hit + 1).some((e) => !floored(e));
    },
    'the floor released',
    45_000,
  );
  // The floor forced a return to the bottom rung after the climb.
  const switched = switchLog.map((s) => s.id);
  const climb = switched.findIndex((id) => id !== 'v-150000');
  expect(climb).toBeGreaterThan(-1);
  expect(switched.slice(climb + 1)).toContain('v-150000');
  expect(engine.quality.allowed.length).toBe(3);
}, 90_000);

it('11. abr-cap-size: shrinking the element caps the allowed set', async () => {
  const player = await boot({ abr: true, capsize: true });
  await play(player, 1, 10_000);
  const { engine, video } = player;
  // The cap is DPR-aware, so the CSS size that admits only the 180p rung
  // depends on the ratio.
  const dpr = Math.min(devicePixelRatio || 1, 2);
  video.style.width = '200px';
  video.style.height = `${Math.floor(180 / dpr)}px`;
  await until(
    () => engine.quality.allowed.length === 1 && engine.quality.allowed[0]?.height === 180,
    'the allowed set capped to 180p',
    10_000,
  );
  // The selection follows the cap; the decoded picture follows the buffer.
  await until(() => engine.quality.active?.height === 180, 'active 180p', 10_000);
  await until(() => engine.quality.playing?.height === 180, 'playing 180p', 30_000);
});

it('12. three constraint sources coexist; releasing one restores only its own', async () => {
  const player = await boot({ abr: true, capsize: true });
  await play(player, 1, 10_000);
  const { engine } = player;

  engine.quality.constrain('saver', { maxBitrate: 200_000 });
  engine.quality.constrain('user', { maxHeight: 300 });
  expect([...engine.quality.constraints.keys()].sort()).toEqual(['element-size', 'saver', 'user']);
  expect(engine.quality.allowed.map((r) => r.bitrate)).toEqual([150_000]);

  // Releasing the saver lifts only the saver's exclusions: the user cap
  // still excludes the 360p rung.
  engine.quality.release('saver');
  expect([...engine.quality.constraints.keys()].sort()).toEqual(['element-size', 'user']);
  expect(engine.quality.allowed.map((r) => r.bitrate).sort((a, b) => a - b)).toEqual([
    150_000, 300_000,
  ]);
});
