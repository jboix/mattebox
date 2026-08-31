import { expect, test } from '@playwright/test';

// Alternate audio and codec switching, end to end. The generated HLS
// master carries two audio groups (aud-lo coupled to the lowest video
// rung, aud-hi to the upper two), each with English and French, so a
// video rung switch drags the audio group and a language switch stays
// inside a group.

async function boot(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/player.html?src=hls');
  await page.waitForFunction(() => window.ready !== undefined);
  await page.evaluate(() => window.ready);
  await page.evaluate(() => void window.video.play());
  await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 15_000 });
}

function activeAudio(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(() => window.engine.tracks.active('audio')?.id ?? null);
}

test('24. audio plays alongside video through its own SourceBuffer', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);
  const state = await page.evaluate(() => {
    const s = window.engine.stats.snapshot();
    return {
      buffers: [...s.buffers.keys()],
      audio: window.engine.tracks.active('audio')?.id ?? null,
    };
  });
  expect(state.buffers).toContain('sb:video');
  expect(state.buffers).toContain('sb:audio');
  // The default audio track is in the group coupled to the startup rung.
  expect(state.audio).toContain('aud-lo');
});

test('25. selecting French stays in the current group', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);
  const french = await page.evaluate(
    () =>
      window.engine.tracks.available.find(
        (t) => t.contentType === 'audio' && t.lang === 'fr' && t.id.startsWith('aud-lo'),
      )?.id,
  );
  await page.evaluate((id) => window.engine.tracks.select(id as string), french);
  await page.waitForFunction((id) => window.engine.tracks.active('audio')?.id === id, french, {
    timeout: 10_000,
  });
  // Playback continues after the audio switch.
  const t1 = await page.evaluate(() => window.video.currentTime);
  await page.waitForTimeout(2_000);
  expect(await page.evaluate(() => window.video.currentTime)).toBeGreaterThan(t1 + 1);
});

test('26. a video rung switch drags the audio group, sync held', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);
  expect(await activeAudio(page)).toContain('aud-lo');
  // Pin the top rung: its coupling requires the aud-hi group.
  await page.evaluate(() => window.engine.quality.pin('v-600000', { apply: 'soon' }));
  await page.waitForFunction(
    () => (window.engine.tracks.active('audio')?.id ?? '').startsWith('aud-hi'),
    undefined,
    { timeout: 20_000 },
  );
  // Both pipelines keep filling: audio and video buffered ends stay close.
  await page.waitForFunction(() => window.video.currentTime > 6, undefined, { timeout: 25_000 });
  const drift = await page.evaluate(() => {
    const s = window.engine.stats.snapshot();
    const end = (id: string) => {
      const r = s.buffers.get(id)?.ranges ?? [];
      return r.length > 0 ? (r[r.length - 1]?.end ?? 0) : 0;
    };
    return Math.abs(end('sb:video') - end('sb:audio'));
  });
  // The two pipelines share the timeline; their buffered ends track within
  // a couple of segments.
  expect(drift).toBeLessThan(8);
  expect(await page.evaluate(() => window.engine.error?.code ?? null)).toBeNull();
});

test('27. the abr suite still holds with audio present', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/player.html?src=hls&abr=1&profile=step-down');
  await page.waitForFunction(() => window.ready !== undefined);
  await page.evaluate(() => window.ready);
  await page.evaluate(() => void window.video.play());
  // Playback establishes first.
  await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 20_000 });
  // The drop to 250 kbps leaves only the lowest rung sustainable; the
  // audio group follows video down and never orphans.
  await page.waitForFunction(() => window.engine.quality.active?.bitrate === 150000, undefined, {
    timeout: 45_000,
  });
  const audio = await activeAudio(page);
  expect(audio).not.toBeNull();
  // Playback kept advancing through the adaptation.
  const t1 = await page.evaluate(() => window.video.currentTime);
  await page.waitForTimeout(2_000);
  expect(await page.evaluate(() => window.video.currentTime)).toBeGreaterThan(t1 + 1);
});
