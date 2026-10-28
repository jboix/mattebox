import { afterEach, describe, expect, it } from 'vitest';
import type { InterstitialsApi } from '../../src/stages/interstitials/index.js';
import { boot, disposeAll, type Player, start, until } from './harness.js';

// Breaks over the flavor's lowest rung (gen-interstitials.mjs). The ad is
// 8 s of colour bars at 320x180 with a tone; the content is 72 s of the
// test pattern. The engine loads the ad in the content's place and loads
// the content again at the resume point.

afterEach(disposeAll);

const api = (player: Player) =>
  (player.engine as unknown as { interstitials: InterstitialsApi }).interstitials;

/** Every interstitials event, in order, as `name id`. */
function record(player: Player): string[] {
  const log: string[] = [];
  for (const name of ['break-start', 'asset-start', 'asset-end', 'break-end']) {
    player.engine.on(`interstitials:${name}`, (payload) => {
      log.push(`${name} ${(payload as { id: string }).id}`);
    });
  }
  return log;
}

describe('interstitials', () => {
  it('63. plays the pre-roll before the first frame, then the content from 0', async () => {
    const player = await boot({ src: 'breaks' });
    const log = record(player);
    start(player);
    await until(() => api(player).playing?.break.id === 'pre', 'the pre-roll playing', 15_000);
    await until(() => log.includes('break-end pre'), 'the pre-roll over', 20_000);
    await until(
      () => player.video.currentTime > 1 && api(player).playing === null,
      'the content',
      15_000,
    );
    expect(player.video.currentTime).toBeLessThan(8);
    expect(log.slice(0, 4)).toEqual([
      'break-start pre',
      'asset-start pre',
      'asset-end pre',
      'break-end pre',
    ]);
    // The content plays, no longer the 8 s ad.
    expect(player.video.duration).toBeGreaterThan(60);
  });

  it('64. a seek past a break that may not be jumped plays it, then lands on the seek target', async () => {
    const player = await boot({ src: 'breaks' });
    const log = record(player);
    start(player);
    await until(() => log.includes('break-end pre'), 'the pre-roll over', 30_000);
    await until(
      () => player.video.currentTime > 0.5 && api(player).playing === null,
      'the content',
      15_000,
    );
    // The insert at 20 s is not restricted: the seek skips it. The replace at 40 s is.
    player.video.currentTime = 46;
    await until(() => api(player).playing?.break.id === 'replace', 'the replace break', 15_000);
    expect(log).not.toContain('break-start mid');
    expect(api(player).skip()).toBe(false);
    await until(() => log.includes('break-end replace'), 'the replace break over', 20_000);
    await until(
      () => player.video.currentTime > 46 && !player.video.seeking,
      'back at 46 s',
      15_000,
    );
    expect(player.video.currentTime).toBeLessThan(52);
  });

  it('68. after the post-roll the programme comes back at its end, paused, and is over', async () => {
    const player = await boot({ src: 'breaks' });
    const log = record(player);
    let over = false;
    player.engine.on('interstitials:ended', () => {
      over = true;
    });
    start(player);
    await until(() => log.includes('break-end pre'), 'the pre-roll over', 30_000);
    await until(
      () => player.video.currentTime > 0.5 && api(player).playing === null,
      'the content',
      15_000,
    );
    // Past the replace at 40 s, which may not be jumped: it plays first, then 69 s.
    player.video.currentTime = 69;
    await until(() => log.includes('break-end replace'), 'the replace break over', 30_000);
    await until(() => log.includes('break-start post'), 'the post-roll', 30_000);
    await until(() => over, 'the end after the post-roll', 30_000);
    await until(() => player.video.duration > 60, 'the programme back', 15_000);
    expect(player.video.paused).toBe(true);
    expect(api(player).ended).toBe(true);
  });

  it('65. plays each asset of an asset list, and the seek bar timeline counts them', async () => {
    const player = await boot({ src: 'breaks-list' });
    const log = record(player);
    player.video.currentTime = 17;
    start(player);
    await until(() => log.includes('break-end list'), 'the asset list played', 40_000);
    expect(log.filter((entry) => entry === 'asset-start list')).toHaveLength(2);
    await until(
      () => player.video.currentTime > 20.5 && api(player).playing === null,
      'back at 20 s',
      15_000,
    );
    // Two 8 s ads inserted at 20 s.
    expect(api(player).integrated.currentTime).toBeGreaterThan(36);
    expect(api(player).integrated.duration).toBeCloseTo(72 + 16, 0);
  });

  it('66. reports a cue-out the content plays through', async () => {
    const player = await boot({ src: 'breaks-cue' });
    const log = record(player);
    const opportunities: string[] = [];
    player.engine.on('interstitials:opportunity', (payload) => {
      opportunities.push((payload as { id: string }).id);
    });
    player.video.currentTime = 22;
    start(player);
    await until(() => log.includes('break-end cue-out-6'), 'the cue-in', 20_000);
    expect(opportunities).toEqual(['cue-out-6']);
    expect(api(player).breaks[0]?.scte35?.commandType).toBe(5);
    // The content played through: no ad was loaded.
    expect(log).toEqual(['break-start cue-out-6', 'break-end cue-out-6']);
  });

  it('69. reports a SCTE35-OUT date range the content plays through, with its section', async () => {
    const player = await boot({ src: 'breaks-scte35' });
    const log = record(player);
    player.video.currentTime = 22;
    start(player);
    await until(() => log.includes('break-end splice-24'), 'the end of the span', 20_000);
    expect(log).toEqual(['break-start splice-24', 'break-end splice-24']);
    expect(api(player).breaks[0]).toMatchObject({ source: 'scte35', start: 24, covers: 8 });
    expect(api(player).breaks[0]?.scte35?.commandType).toBe(6);
  });

  it('67. DASH: plays an alternative MPD insert, then the content where it stopped', async () => {
    const player = await boot({ src: 'breaks-dash' });
    const log = record(player);
    player.video.currentTime = 18;
    start(player);
    await until(() => api(player).playing?.break.id === 'insert-20', 'the insert', 15_000);
    await until(() => log.includes('break-end insert-20'), 'the insert over', 20_000);
    await until(
      () => player.video.currentTime > 20.2 && api(player).playing === null,
      'back at 20 s',
      15_000,
    );
    expect(player.video.currentTime).toBeLessThan(26);
  });
});
