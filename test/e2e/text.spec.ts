import { expect, test } from '@playwright/test';

// The third pipeline, end to end: segmented WebVTT through the sink
// interface, rendered by native TextTracks, offsets applied per segment.

async function boot(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/player.html?src=hls');
  await page.waitForFunction(() => window.ready !== undefined);
  await page.evaluate(() => window.ready);
  await page.evaluate(() => void window.video.play());
  await page.waitForFunction(() => window.video.currentTime > 1, undefined, { timeout: 10_000 });
}

function subsTrackId(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(
    () => window.engine.tracks.available.find((t) => t.contentType === 'text')?.id ?? null,
  );
}

test('14. selecting the subtitle track shows cues at the mapped times', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);
  const trackId = await subsTrackId(page);
  expect(trackId).not.toBeNull();
  await page.evaluate((id) => window.engine.tracks.select(id as string), trackId);

  // Cues arrive through the native TextTrack the sink created.
  await page.waitForFunction(
    () => {
      const tracks = [...window.video.textTracks];
      return tracks.some((t) => (t.cues?.length ?? 0) > 0);
    },
    undefined,
    { timeout: 15_000 },
  );
  const cues = await page.evaluate(() => {
    const track = [...window.video.textTracks].find((t) => (t.cues?.length ?? 0) > 0);
    return [...(track?.cues ?? [])].slice(0, 3).map((c) => ({
      start: c.startTime,
      end: c.endTime,
      text: (c as VTTCue).text,
    }));
  });
  // Segment N carries "cue N" at local 0.5 with MPEGTS N*4s: the offsets land
  // each cue inside its own segment's window.
  expect(cues[0]).toMatchObject({ start: 0.5, end: 3.5, text: 'cue 0' });
  if (cues.length > 1) {
    expect(cues[1]).toMatchObject({ start: 4.5, end: 7.5, text: 'cue 1' });
  }
});

test('15. seeking fetches the target window and cues follow', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);
  const trackId = await subsTrackId(page);
  await page.evaluate((id) => window.engine.tracks.select(id as string), trackId);
  await page.waitForFunction(
    () => [...window.video.textTracks].some((t) => (t.cues?.length ?? 0) > 0),
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate(() => {
    window.engine.dispatch({ type: 'SEEK', to: 60 });
  });
  await page.waitForFunction(() => window.video.currentTime > 60, undefined, { timeout: 15_000 });
  // The cue covering the seek target arrives.
  await page.waitForFunction(
    () => {
      const track = [...window.video.textTracks].find((t) => (t.cues?.length ?? 0) > 0);
      return [...(track?.cues ?? [])].some((c) => c.startTime >= 60 && c.startTime < 64);
    },
    undefined,
    { timeout: 15_000 },
  );
});

test('16. deselecting stops the pipeline and clears cues', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);
  const trackId = await subsTrackId(page);
  await page.evaluate((id) => window.engine.tracks.select(id as string), trackId);
  await page.waitForFunction(
    () => [...window.video.textTracks].some((t) => (t.cues?.length ?? 0) > 0),
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate(() => window.engine.tracks.deselect('text'));
  await page.waitForFunction(
    () => [...window.video.textTracks].every((t) => (t.cues?.length ?? 0) === 0),
    undefined,
    { timeout: 5_000 },
  );
  // Playback is untouched and the pipeline stays quiet.
  const t1 = await page.evaluate(() => window.video.currentTime);
  await page.waitForTimeout(1_500);
  const state = await page.evaluate(() => ({
    t: window.video.currentTime,
    active: window.engine.tracks.active('text'),
    error: window.engine.error?.code ?? null,
  }));
  expect(state.t).toBeGreaterThan(t1 + 1);
  expect(state.active).toBeNull();
  expect(state.error).toBeNull();
});
