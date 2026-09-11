import { afterEach, expect, it } from 'vitest';
import type { Player } from './harness.js';
import { boot, disposeAll, play, sleep, until } from './harness.js';

// Alternate audio and codec switching, end to end. The generated HLS
// master carries two audio groups (aud-lo coupled to the lowest video
// rung, aud-hi to the upper two), each with English and French, so a
// video rung switch drags the audio group and a language switch stays
// inside a group.

afterEach(disposeAll);

async function bootPlaying(): Promise<Player> {
  const player = await boot({ src: 'hls' });
  await play(player, 1, 15_000);
  return player;
}

function activeAudio(player: Player): string | null {
  return player.engine.tracks.active('audio')?.id ?? null;
}

it('24. audio plays alongside video through its own SourceBuffer', async () => {
  const player = await bootPlaying();
  const buffers = [...player.engine.stats.snapshot().buffers.keys()];
  expect(buffers).toContain('sb:video');
  expect(buffers).toContain('sb:audio');
  // The default audio track is in the group coupled to the startup rung.
  expect(activeAudio(player)).toContain('aud-lo');
});

it('25. selecting French stays in the current group', async () => {
  const player = await bootPlaying();
  const { engine, video } = player;
  const french = engine.tracks.available.find(
    (t) => t.contentType === 'audio' && t.lang === 'fr' && t.id.startsWith('aud-lo'),
  )?.id;
  engine.tracks.select(french as string);
  await until(() => activeAudio(player) === french, 'the French track active', 10_000);
  // Playback continues after the audio switch.
  const t1 = video.currentTime;
  await sleep(2_000);
  expect(video.currentTime).toBeGreaterThan(t1 + 1);
});

it('26. a video rung switch drags the audio group, sync held', async () => {
  const player = await bootPlaying();
  const { engine, video } = player;
  expect(activeAudio(player)).toContain('aud-lo');
  // Pin the top rung: its coupling requires the aud-hi group.
  engine.quality.pin('v-600000', { apply: 'soon' });
  await until(() => (activeAudio(player) ?? '').startsWith('aud-hi'), 'the aud-hi group', 20_000);
  // Both pipelines keep filling: audio and video buffered ends stay close.
  await until(() => video.currentTime > 6, 'currentTime > 6', 25_000);
  const buffers = engine.stats.snapshot().buffers;
  const end = (id: string) => {
    const r = buffers.get(id)?.ranges ?? [];
    return r.length > 0 ? (r[r.length - 1]?.end ?? 0) : 0;
  };
  // The two pipelines share the timeline; their buffered ends track within
  // a couple of segments.
  expect(Math.abs(end('sb:video') - end('sb:audio'))).toBeLessThan(8);
  expect(engine.error?.code ?? null).toBeNull();
});

it('27. the abr suite still holds with audio present', async () => {
  const player = await boot({ src: 'hls', abr: true, profile: 'step-down' });
  // Playback establishes first.
  await play(player, 1, 20_000);
  const { engine, video } = player;
  // The drop to 250 kbps leaves only the lowest rung sustainable; the
  // audio group follows video down and never orphans.
  await until(() => engine.quality.active?.bitrate === 150_000, 'the drop', 45_000);
  expect(activeAudio(player)).not.toBeNull();
  // Playback kept advancing through the adaptation.
  const t1 = video.currentTime;
  await sleep(2_000);
  expect(video.currentTime).toBeGreaterThan(t1 + 1);
}, 90_000);
