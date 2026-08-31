import { describe, expect, it } from 'vitest';
import { mattebox } from '../../../src/index.js';
import hlsCmaf from '../../../src/protocols/hls-cmaf/index.js';
import pdt from '../../../src/stages/pdt/index.js';
import { pickVideoProfile, waitFor } from './helpers.js';

const profile = pickVideoProfile();

// A one-segment VOD served from memory, its init and media segment the
// committed fixtures the buffer tests use. Nothing here needs the generated
// E2E corpus, which CI's verify job does not have.
const ORIGIN = 'https://stream.test';
const SEGMENTS = new URL('../../fixtures/segments/', import.meta.url).href;
const codecs = /codecs="([^"]+)"/.exec(profile?.type ?? '')?.[1] ?? 'avc1.42E01E';
const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="${codecs}",RESOLUTION=320x180
media.m3u8
`;
const MEDIA = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="${SEGMENTS}${profile?.init ?? ''}"
#EXTINF:4.0,
${SEGMENTS}${profile?.seg ?? ''}
#EXT-X-ENDLIST
`;

function playlist(body: string): Promise<Response> {
  return Promise.resolve(
    new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    }),
  );
}

function fetchImpl(url: string, init: RequestInit): Promise<Response> {
  if (url === `${ORIGIN}/master.m3u8`) return playlist(MASTER);
  if (url === `${ORIGIN}/media.m3u8`) return playlist(MEDIA);
  return fetch(url, init);
}

function video(): HTMLVideoElement {
  const el = document.createElement('video');
  el.muted = true;
  document.body.appendChild(el);
  return el;
}

describe('media errors', () => {
  it.runIf(profile !== null)(
    'an element error is reported as a fatal engine error, not hidden by a reload',
    async () => {
      const el = video();
      const engine = mattebox({ stages: [hlsCmaf()], transport: { fetchImpl } });
      const errors: unknown[] = [];
      engine.on('error', (payload) => errors.push(payload));
      await engine.attach(el);
      engine.load(`${ORIGIN}/master.m3u8`);
      await waitFor(() => engine.stats.snapshot().presentation !== null, 'manifest', 20_000);
      const attaches = () => engine.stats.trace().filter((e) => e.msg.type === 'ATTACH').length;
      expect(attaches()).toBe(1);

      el.dispatchEvent(new Event('error'));

      expect(errors.at(-1)).toMatchObject({ code: 'MEDIA_DECODE_ERROR', fatal: true });
      expect(engine.error?.code).toBe('MEDIA_DECODE_ERROR');
      expect(engine.media).toBe(el);
      // Nothing was rebuilt.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(attaches()).toBe(1);
      await engine.detach();
      el.remove();
    },
    30_000,
  );

  it('detach and attach with stages loaded installs them cleanly again', async () => {
    const el = video();
    const engine = mattebox({ stages: [hlsCmaf(), pdt()] });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await engine.attach(el);
      expect('pdt' in engine).toBe(true);
      await engine.detach();
      expect('pdt' in engine).toBe(false);
    }
    el.remove();
  });
});

describe('sources the engine cannot play', () => {
  function engineWith(response: () => Response) {
    return mattebox({
      stages: [hlsCmaf()],
      transport: { fetchImpl: () => Promise.resolve(response()) },
    });
  }

  async function loadAndFail(engine: ReturnType<typeof mattebox>, url: string): Promise<unknown[]> {
    const el = video();
    const errors: unknown[] = [];
    engine.on('error', (payload) => errors.push(payload));
    await engine.attach(el);
    engine.load(url);
    await waitFor(() => engine.error !== null, 'fatal error', 10_000);
    expect(engine.stats.snapshot().lifecycle.phase).toBe('error');
    await engine.detach();
    el.remove();
    return errors;
  }

  it('an audio file is refused by Content-Type before its body downloads', async () => {
    let bodyPulls = 0;
    const engine = engineWith(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              bodyPulls += 1;
              controller.enqueue(new Uint8Array(1024));
            },
          }),
          { status: 200, headers: { 'content-type': 'audio/mpeg' } },
        ),
    );
    const errors = await loadAndFail(engine, 'https://cdn.example/song.mp3');
    expect(errors.at(-1)).toMatchObject({
      code: 'MANIFEST_UNSUPPORTED',
      fatal: true,
      contentType: 'audio/mpeg',
    });
    expect(engine.error?.code).toBe('MANIFEST_UNSUPPORTED');
    expect(bodyPulls).toBeLessThanOrEqual(1);
  });

  it('bytes no adapter recognizes are unsupported, not a parse failure', async () => {
    const engine = engineWith(
      () =>
        new Response(new TextEncoder().encode('ID3 not a playlist'), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
    );
    const errors = await loadAndFail(engine, 'https://cdn.example/opaque');
    expect(errors.at(-1)).toMatchObject({ code: 'MANIFEST_UNSUPPORTED', fatal: true });
  });

  it('a mimeType nothing composed accepts fails without a request', async () => {
    let requests = 0;
    const engine = mattebox({
      stages: [hlsCmaf()],
      transport: {
        fetchImpl: () => {
          requests += 1;
          return Promise.resolve(new Response(null, { status: 200 }));
        },
      },
    });
    const el = video();
    const errors: unknown[] = [];
    engine.on('error', (payload) => errors.push(payload));
    await engine.attach(el);
    engine.load('https://cdn.example/song.mp3', { mimeType: 'audio/mpeg' });
    expect(errors.at(-1)).toMatchObject({ code: 'MANIFEST_UNSUPPORTED', mimeType: 'audio/mpeg' });
    expect(requests).toBe(0);
    expect(engine.accepts('audio/mpeg')).toBe(false);
    expect(engine.accepts('application/vnd.apple.mpegurl')).toBe(true);
    await engine.detach();
    el.remove();
  });
});
