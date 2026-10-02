import { afterEach, expect, it } from 'vitest';
import type { Player } from './harness.js';
import { boot, decodesH264, disposeAll, play, sleep, until } from './harness.js';

// The third pipeline, end to end: segmented WebVTT through the sink
// interface, rendered by native TextTracks, offsets applied per segment.

afterEach(disposeAll);

async function bootWithSubs(): Promise<Player> {
  const player = await boot({ src: 'hls' });
  await play(player, 1, 10_000);
  return player;
}

function subsTrackId(player: Player): string | null {
  return player.engine.tracks.available.find((t) => t.contentType === 'text')?.id ?? null;
}

function trackWithCues(video: HTMLVideoElement): TextTrack | undefined {
  return [...video.textTracks].find((t) => (t.cues?.length ?? 0) > 0);
}

async function selectAndWaitForCues(player: Player): Promise<void> {
  const trackId = subsTrackId(player);
  expect(trackId).not.toBeNull();
  player.engine.tracks.select(trackId as string);
  // Cues arrive through the native TextTrack the sink created.
  await until(() => trackWithCues(player.video) !== undefined, 'cues', 15_000);
}

it('14. selecting the subtitle track shows cues at the mapped times', async () => {
  const player = await bootWithSubs();
  await selectAndWaitForCues(player);
  const cues = [...(trackWithCues(player.video)?.cues ?? [])].slice(0, 3).map((c) => ({
    start: c.startTime,
    end: c.endTime,
    text: (c as VTTCue).text,
  }));
  // Segment N carries "cue N" at local 0.5 with MPEGTS N*4s: the offsets land
  // each cue inside its own segment's window.
  expect(cues[0]).toMatchObject({ start: 0.5, end: 3.5, text: 'cue 0' });
  if (cues.length > 1) {
    expect(cues[1]).toMatchObject({ start: 4.5, end: 7.5, text: 'cue 1' });
  }
});

it('15. seeking fetches the target window and cues follow', async () => {
  const player = await bootWithSubs();
  await selectAndWaitForCues(player);
  player.engine.dispatch({ type: 'SEEK', to: 60 });
  await until(() => player.video.currentTime > 60, 'playback past 60 s', 15_000);
  // The cue covering the seek target arrives.
  await until(
    () =>
      [...(trackWithCues(player.video)?.cues ?? [])].some(
        (c) => c.startTime >= 60 && c.startTime < 64,
      ),
    'a cue in [60, 64)',
    15_000,
  );
});

it('16. deselecting stops the pipeline and clears cues', async () => {
  const player = await bootWithSubs();
  await selectAndWaitForCues(player);
  player.engine.tracks.deselect('text');
  await until(
    () => [...player.video.textTracks].every((t) => (t.cues?.length ?? 0) === 0),
    'cues cleared',
    5_000,
  );
  // Playback is untouched and the pipeline stays quiet.
  const t1 = player.video.currentTime;
  await sleep(1_500);
  expect(player.video.currentTime).toBeGreaterThan(t1 + 1);
  expect(player.engine.tracks.active('text')).toBeNull();
  expect(player.engine.error?.code ?? null).toBeNull();
});

it('17. a forced track shows without a selection and returns after Off', async () => {
  const player = await boot({ src: 'forced' });
  await play(player, 1, 10_000);
  // Nothing selected text: the forced track for the English audio shows.
  await until(() => player.engine.tracks.active('text')?.forced === true, 'forced track', 5_000);
  await until(() => trackWithCues(player.video) !== undefined, 'forced cues', 15_000);
  // A regular subtitle replaces it.
  const regular = player.engine.tracks.available.find(
    (t) => t.contentType === 'text' && t.forced !== true,
  );
  player.engine.tracks.select(regular?.id as string);
  await until(() => player.engine.tracks.active('text')?.id === regular?.id, 'regular', 5_000);
  // Off brings the forced track back.
  player.engine.tracks.deselect('text');
  await until(() => player.engine.tracks.active('text')?.forced === true, 'forced again', 5_000);
  expect(player.engine.tracks.active('text')?.lang).toBe('en');
  // French audio in the same group brings the French forced track.
  const group = player.engine.tracks.active('audio')?.id.split(':')[0];
  player.engine.tracks.select(`${group}:French`);
  await until(() => player.engine.tracks.active('text')?.lang === 'fr', 'French forced', 5_000);
  expect(player.engine.tracks.active('text')?.forced).toBe(true);
  expect(player.engine.error?.code ?? null).toBeNull();
});

// CEA-608 in the video: the corpus injects "CCn k" on all four channels of
// segment k, from frame 6 (CC1, CC3) and 18 (CC2, CC4) to about 3.33 s.
function nativeCaption(video: HTMLVideoElement, label: string): TextTrack | undefined {
  return [...video.textTracks].find((t) => t.kind === 'captions' && t.label === label);
}

it.skipIf(!decodesH264)('18. declared CC1 to CC4 are tracks, each with its own cues', async () => {
  const player = await boot({ src: 'captions' });
  await play(player, 2, 15_000);
  const captions = player.engine.tracks.available.filter((t) => t.role === 'caption');
  expect(captions.map((t) => t.instreamId)).toEqual(['CC1', 'CC2', 'CC3', 'CC4']);
  expect(captions.every((t) => player.engine.tracks.selectable(t.id))).toBe(true);
  for (const channel of ['CC1', 'CC2', 'CC3', 'CC4']) {
    await until(
      () => (nativeCaption(player.video, channel)?.cues?.length ?? 0) > 0,
      `${channel} cues`,
      15_000,
    );
    const first = nativeCaption(player.video, channel)?.cues?.[0] as VTTCue;
    expect(first.text).toBe(`${channel} 0`);
    expect(first.endTime).toBeCloseTo(100 / 30, 1);
  }
  // Selecting the Spanish channel shows it; the others stay hidden.
  const spanish = captions.find((t) => t.instreamId === 'CC3');
  player.engine.tracks.select(spanish?.id as string);
  await until(() => nativeCaption(player.video, 'CC3')?.mode === 'showing', 'CC3 showing', 5_000);
  expect(nativeCaption(player.video, 'CC3')?.language).toBe('es');
  expect(nativeCaption(player.video, 'CC1')?.mode).toBe('hidden');
  expect(player.engine.error?.code ?? null).toBeNull();
});

it.skipIf(!decodesH264)('19. undeclared channels become tracks on their first cue', async () => {
  const player = await boot({ src: 'captions-undeclared' });
  expect(player.engine.tracks.available.some((t) => t.role === 'caption')).toBe(false);
  await play(player, 2, 15_000);
  await until(
    () => player.engine.tracks.available.filter((t) => t.role === 'caption').length === 4,
    'four caption tracks',
    15_000,
  );
  const ids = player.engine.tracks.available.filter((t) => t.role === 'caption').map((t) => t.id);
  expect(ids.sort()).toEqual(['cea608:CC1', 'cea608:CC2', 'cea608:CC3', 'cea608:CC4']);
  player.engine.tracks.select('cea608:CC2');
  await until(() => nativeCaption(player.video, 'CC2')?.mode === 'showing', 'CC2 showing', 5_000);
});

it.skipIf(!decodesH264)('45. CEA-708 services are tracks beside the 608 channels', async () => {
  const player = await boot({ src: 'captions-708' });
  await play(player, 2, 15_000);
  // Service 1 is declared; service 2 appears on its first cue.
  await until(
    () => player.engine.tracks.available.some((t) => t.id === 'cea708:SERVICE2'),
    'service 2 added',
    15_000,
  );
  const services = player.engine.tracks.available.filter(
    (t) => t.mimeType === 'application/cea-708',
  );
  expect(services.map((t) => t.instreamId).sort()).toEqual(['SERVICE1', 'SERVICE2']);
  for (const [label, text, line] of [
    ['SERVICE1', 'SERVICE1 0', 90],
    ['SERVICE2', 'SERVICE2 0', 10],
  ] as const) {
    await until(
      () => (nativeCaption(player.video, label)?.cues?.length ?? 0) > 0,
      `${label} cues`,
      15_000,
    );
    const first = nativeCaption(player.video, label)?.cues?.[0] as VTTCue;
    expect(first.text).toBe(text);
    expect(first.line).toBe(line);
    expect(first.endTime).toBeCloseTo(100 / 30, 1);
  }
  // The 608 channels keep working beside them.
  await until(
    () => (nativeCaption(player.video, 'CC1')?.cues?.length ?? 0) > 0,
    'CC1 cues',
    15_000,
  );
  const declared = services.find((t) => t.instreamId === 'SERVICE1');
  player.engine.tracks.select(declared?.id as string);
  await until(
    () => nativeCaption(player.video, 'SERVICE1')?.mode === 'showing',
    'SERVICE1 showing',
    5_000,
  );
  expect(nativeCaption(player.video, 'SERVICE1')?.language).toBe('en');
  expect(player.engine.error?.code ?? null).toBeNull();
});

// TTML beside the DASH corpus (gen-ttml.mjs): "sidecar n" from 4n + 1 s to
// 4n + 3 s, and "stpp n" from 0.5 s to 3.5 s into segment n, timed on the
// stpp track's media clock.
function nativeText(video: HTMLVideoElement, id: string): TextTrack | undefined {
  return [...video.textTracks].find((t) => t.label === `mattebox:${id}`);
}

it('46. TTML plays as a sidecar and as stpp in fMP4, each through its parser', async () => {
  const player = await boot({ src: 'ttml' });
  await play(player, 1, 15_000);
  const text = player.engine.tracks.available.filter((t) => t.contentType === 'text');
  expect(text.map((t) => [t.id, t.lang, player.engine.tracks.selectable(t.id)])).toEqual([
    ['as-10', 'en', true],
    ['as-11', 'de', true],
    ['as-12', 'fr', true],
  ]);
  player.engine.tracks.select('as-10');
  await until(
    () => (nativeText(player.video, 'as-10')?.cues?.length ?? 0) > 2,
    'sidecar cues',
    15_000,
  );
  const sidecar = nativeText(player.video, 'as-10')?.cues?.[1] as VTTCue;
  expect([sidecar.startTime, sidecar.endTime, sidecar.text]).toEqual([5, 7, 'sidecar 1']);
  expect(sidecar.line).toBe(95);
  player.engine.tracks.select('as-11');
  await until(
    () => (nativeText(player.video, 'as-11')?.cues?.length ?? 0) > 1,
    'stpp cues',
    15_000,
  );
  const second = [...(nativeText(player.video, 'as-11')?.cues ?? [])].find(
    (cue) => (cue as VTTCue).text === 'stpp 2',
  ) as VTTCue;
  expect([second.startTime, second.endTime]).toEqual([4.5, 7.5]);
  expect(nativeText(player.video, 'as-11')?.mode).toBe('showing');
  expect(nativeText(player.video, 'as-10')?.mode).toBe('disabled');
  expect(player.engine.error?.code ?? null).toBeNull();
});

it('48. WebVTT in fMP4 plays through text-webvtt, one cue per vttc span', async () => {
  const player = await boot({ src: 'ttml' });
  await play(player, 1, 15_000);
  player.engine.tracks.select('as-12');
  await until(
    () => (nativeText(player.video, 'as-12')?.cues?.length ?? 0) > 1,
    'wvtt cues',
    15_000,
  );
  const second = [...(nativeText(player.video, 'as-12')?.cues ?? [])].find(
    (cue) => (cue as VTTCue).text === 'wvtt 2',
  ) as VTTCue;
  expect([second.startTime, second.endTime, second.line]).toEqual([4, 6, 85]);
  expect(nativeText(player.video, 'as-12')?.mode).toBe('showing');
  expect(player.engine.error?.code ?? null).toBeNull();
});
