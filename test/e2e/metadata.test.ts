import { afterEach, describe, expect, it } from 'vitest';
import type { MetadataApi } from '../../src/stages/timed-metadata/index.js';
import { boot, decodesH264, disposeAll, play, until } from './harness.js';

// Timed metadata from the manifest and the bytes, in one list. The stream is
// the muxed TS corpus with an ID3 stream added (inject-id3.mjs): segment n
// carries a TXXX "segment n" one second after its first frame, and the
// playlist dates a span from 2 s to 6 s and an instant at 9 s. TS is H.264,
// so these run where H.264 decodes.

afterEach(disposeAll);

describe.skipIf(!decodesH264)('timed metadata', () => {
  it('43. lists date ranges and the transmuxed ID3 tags, and enters and exits them on time', async () => {
    const player = await boot({ src: 'metadata' });
    const log: string[] = [];
    for (const name of ['metadata:enter', 'metadata:exit']) {
      player.engine.on(name, (payload) => {
        log.push(`${name.slice(9)} ${(payload as { id: string }).id}`);
      });
    }
    const metadata = (player.engine as unknown as { metadata: MetadataApi }).metadata;
    await play(player, 3, 20_000);

    const span = metadata.events.find((e) => e.id === 'span');
    expect(span).toMatchObject({
      source: 'daterange',
      scheme: 'com.example.span',
      start: 2,
      end: 6,
    });
    expect(span?.attributes['X-NOTE']).toBe('two to six');
    expect(metadata.events.find((e) => e.id === 'instant')).toMatchObject({ start: 9, end: 9 });

    const first = metadata.events.find((e) => e.source === 'id3');
    expect(first?.frames?.[0]).toMatchObject({ id: 'TXXX', value: 'segment 0' });
    // One second after the first frame, which may sit a frame after zero.
    expect(first?.start).toBeGreaterThanOrEqual(1);
    expect(first?.start).toBeLessThan(1.2);

    expect(log).toContain(`enter ${first?.id}`);
    expect(log).toContain(`exit ${first?.id}`);
    expect(log).toContain('enter span');
    expect(log).not.toContain('exit span');
    expect(metadata.at(player.video.currentTime).map((e) => e.id)).toContain('span');

    // Pages that read textTracks see the same records as cues.
    const track = [...player.video.textTracks].find(
      (t) => t.kind === 'metadata' && t.label === 'metadata',
    );
    expect(track?.mode).toBe('hidden');
    const texts = [...(track?.cues ?? [])].map((cue) => (cue as VTTCue).text);
    expect(texts.some((text) => JSON.parse(text).id === 'span')).toBe(true);
  });

  it('44. a seek exits the span it leaves and skips the instants it jumps', async () => {
    const player = await boot({ src: 'metadata' });
    const log: string[] = [];
    for (const name of ['metadata:enter', 'metadata:exit']) {
      player.engine.on(name, (payload) => {
        log.push(`${name.slice(9)} ${(payload as { id: string }).id}`);
      });
    }
    await play(player, 2.5, 20_000);
    await until(() => log.includes('enter span'), 'the span entered', 10_000);
    log.length = 0;
    player.engine.dispatch({ type: 'SEEK', to: 20 });
    await until(
      () => player.video.currentTime > 20.2 && !player.video.seeking,
      'playback past 20 s',
      15_000,
    );
    expect(log).toContain('exit span');
    expect(log).not.toContain('enter instant');
    expect(log.filter((entry) => entry.startsWith('enter id3'))).toEqual([]);
  });
});
