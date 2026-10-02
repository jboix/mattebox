import { afterEach, describe, expect, it } from 'vitest';
import { mattebox } from '../../../src/index.js';
import hlsCmaf from '../../../src/protocols/hls-cmaf/index.js';
import { waitFor } from './helpers.js';

/**
 * engine.preload keeps a manifest for the next load of its URL: the load
 * then starts without fetching it again. A stub fetch serves the playlists
 * from memory and counts requests.
 */

const MASTER = 'https://cdn.example/next/master.m3u8';
const PLAYLISTS: Record<string, string> = {
  // Playwright's Chromium decodes no H.264: VP9 there, so the variant stays decodable.
  [MASTER]: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="${
    MediaSource.isTypeSupported('video/mp4; codecs="avc1.42c01e"') ? 'avc1.42c01e' : 'vp09.00.10.08'
  }"\nv.m3u8\n`,
  'https://cdn.example/next/v.m3u8':
    '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\nseg0.m4s\n#EXT-X-ENDLIST\n',
};

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function engineWithStub() {
  const requested: string[] = [];
  const fetchImpl = (url: string): Promise<Response> => {
    requested.push(url);
    const body = PLAYLISTS[url.split('?')[0] as string];
    return Promise.resolve(
      body === undefined
        ? new Response(null, { status: 404 })
        : new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          }),
    );
  };
  const engine = mattebox({ stages: [hlsCmaf()], transport: { fetchImpl } });
  const video = document.createElement('video');
  disposers.push(() => engine.detach());
  return { engine, video, requested };
}

describe('engine.preload', () => {
  it('fetches the manifest once for a preload followed by a load', async () => {
    const { engine, video, requested } = engineWithStub();
    await engine.preload(MASTER);
    expect(requested).toEqual([MASTER]);
    await engine.attach(video);
    engine.load(MASTER);
    await waitFor(() => engine.tracks.available.length > 0, 'the preloaded manifest parsed');
    expect(requested.filter((url) => url === MASTER)).toEqual([MASTER]);
  });

  it('rejects a failed preload, and the load fetches as usual', async () => {
    const { engine, video, requested } = engineWithStub();
    const missing = 'https://cdn.example/missing.m3u8';
    await expect(engine.preload(missing)).rejects.toMatchObject({
      code: 'NETWORK_HTTP_STATUS',
      status: 404,
    });
    await expect(
      engine.preload(MASTER, { mimeType: 'application/dash+xml' }),
    ).rejects.toMatchObject({
      code: 'MANIFEST_UNSUPPORTED',
    });
    await engine.attach(video);
    engine.load(MASTER);
    await waitFor(() => engine.tracks.available.length > 0, 'the manifest parsed');
    expect(requested.filter((url) => url === MASTER)).toEqual([MASTER]);
    expect(requested[0]).toBe(missing);
  });
});
