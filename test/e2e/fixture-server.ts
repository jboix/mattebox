// The E2E fixture server as a Vite plugin: the generated stream corpus with
// streaming-correct MIME types, plus the live simulator, the steering
// manifest, and the pathway routes, all served by the Vitest browser
// server so the tests and the media share one origin.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vitest/config';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const STREAMS = join(ROOT, 'test/fixtures/streams');

const MIME: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.vtt': 'text/vtt',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.ts': 'video/mp2t',
  '.aac': 'audio/aac',
};

// ---- live simulator -------------------------------------------------------
// A sliding window over the generated VOD segments, anchored at the t0 the
// test supplies, so every boot gets a fresh stream. HLS serves a bare media
// playlist; DASH serves a dynamic MPD over the same chunk files.

const LIVE = { window: 5, duration: 4, total: 18 };
const metaCache = new Map<string, { codecs: string; timescale: number }>();

function dashInfo(flavor: string): { codecs: string; timescale: number } {
  let meta = metaCache.get(flavor);
  if (meta === undefined) {
    const mpd = readFileSync(join(STREAMS, `${flavor}-dash/manifest.mpd`), 'utf8');
    meta = {
      codecs: /codecs="([^"]+)"/.exec(mpd)?.[1] ?? '',
      timescale: Number(/timescale="(\d+)"/.exec(mpd)?.[1] ?? 15360),
    };
    metaCache.set(flavor, meta);
  }
  return meta;
}

// The video codec alone: the live and steering variants below carry no
// audio group and their segments hold no audio track, so a CODECS that
// still names the master's audio codec promises Chromium a track the init
// segment never delivers, and it rejects the append. Firefox and WebKit
// let it pass, which is how the lie survived.
function hlsCodecs(flavor: string): string {
  const key = `hls:${flavor}`;
  let meta = metaCache.get(key);
  if (meta === undefined) {
    const master = readFileSync(join(STREAMS, `${flavor}/master.m3u8`), 'utf8');
    const codecs = /CODECS="([^"]+)"/.exec(master)?.[1] ?? '';
    meta = { codecs: codecs.split(',')[0]?.trim() ?? '', timescale: 0 };
    metaCache.set(key, meta);
  }
  return meta.codecs;
}

function liveHlsMaster(flavor: string, t0: number): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=320x180,CODECS="${hlsCodecs(flavor)}"`,
    `/live/${flavor}/live.m3u8?t0=${t0}`,
  ].join('\n');
}

function steerMaster(flavor: string): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-CONTENT-STEERING:SERVER-URI="/steer/manifest.json",PATHWAY-ID="a"',
    `#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=320x180,CODECS="${hlsCodecs(flavor)}",PATHWAY-ID="a"`,
    `/pw-a/streams/${flavor}/low.m3u8`,
    `#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=320x180,CODECS="${hlsCodecs(flavor)}",PATHWAY-ID="b"`,
    `/pw-b/streams/${flavor}/low.m3u8`,
  ].join('\n');
}

function liveHls(flavor: string, t0: number): string {
  const elapsed = (Date.now() - t0) / 1000;
  const newest = Math.min(LIVE.total - 1, Math.floor(elapsed / LIVE.duration));
  const oldest = Math.max(0, newest - LIVE.window + 1);
  const ended = elapsed > LIVE.total * LIVE.duration + 8;
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${LIVE.duration}`,
    `#EXT-X-MEDIA-SEQUENCE:${oldest}`,
    `#EXT-X-PROGRAM-DATE-TIME:${new Date(t0 + oldest * LIVE.duration * 1000).toISOString()}`,
    `#EXT-X-MAP:URI="/streams/${flavor}/init-low.mp4"`,
  ];
  for (let seq = oldest; seq <= newest; seq += 1) {
    lines.push(`#EXTINF:${LIVE.duration}.000,`);
    lines.push(`/streams/${flavor}/seg-low-${String(seq).padStart(3, '0')}.m4s`);
  }
  if (ended) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function liveDash(flavor: string, t0: number): string {
  const elapsed = (Date.now() - t0) / 1000;
  const ended = elapsed > LIVE.total * LIVE.duration + 8;
  const { codecs, timescale } = dashInfo(flavor);
  const type = ended ? 'static' : 'dynamic';
  const bounds = ended
    ? `mediaPresentationDuration="PT${LIVE.total * LIVE.duration}S"`
    : `availabilityStartTime="${new Date(t0).toISOString()}" minimumUpdatePeriod="PT4S" timeShiftBufferDepth="PT20S" suggestedPresentationDelay="PT6S"`;
  return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="${type}" ${bounds} profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period id="p0" start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate timescale="${timescale}" duration="${LIVE.duration * timescale}" startNumber="1"
        initialization="/streams/${flavor}-dash/init-stream0.m4s"
        media="/streams/${flavor}-dash/chunk-stream0-$Number%05d$.m4s"/>
      <Representation id="0" codecs="${codecs}" bandwidth="150000" width="320" height="180"/>
    </AdaptationSet>
  </Period>
</MPD>`;
}

// ---- routing --------------------------------------------------------------

function text(res: ServerResponse, contentType: string, body: string): void {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

function serveStream(res: ServerResponse, pathname: string): void {
  const path = normalize(join(STREAMS, pathname.slice('/streams/'.length)));
  if (!path.startsWith(normalize(STREAMS)) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(res);
}

/** True when the request was answered; false hands it back to Vite. */
function handle(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/steer/manifest.json') {
    text(
      res,
      'application/json',
      JSON.stringify({ VERSION: 1, TTL: 300, 'PATHWAY-PRIORITY': ['a', 'b'] }),
    );
    return true;
  }
  const steerMatch = /^\/steer\/(h264|vp9)\/master\.m3u8$/.exec(url.pathname);
  if (steerMatch !== null) {
    text(res, MIME['.m3u8'] as string, steerMaster(steerMatch[1] as string));
    return true;
  }
  // Pathway routes proxy to the real files; pathway a dies at segment 3,
  // which is what forces the failover the steering tests assert.
  const pwMatch = /^\/pw-(a|b)(\/streams\/.*)$/.exec(url.pathname);
  if (pwMatch !== null) {
    const [, pathway, rest] = pwMatch as unknown as [string, string, string];
    if (pathway === 'a' && /seg-\w+-0(0[3-9]|[1-9]\d)\.m4s$/.test(rest)) {
      res.writeHead(404);
      res.end('pathway a is dead');
      return true;
    }
    serveStream(res, rest);
    return true;
  }
  const liveMatch = /^\/live\/(h264|vp9)\/(live|master)\.(m3u8|mpd)$/.exec(url.pathname);
  if (liveMatch !== null) {
    const t0 = Number(url.searchParams.get('t0')) || Date.now();
    const [, flavor, name, kind] = liveMatch as unknown as [string, string, string, string];
    const body =
      kind === 'mpd'
        ? liveDash(flavor, t0)
        : name === 'master'
          ? liveHlsMaster(flavor, t0)
          : liveHls(flavor, t0);
    text(res, kind === 'm3u8' ? (MIME['.m3u8'] as string) : (MIME['.mpd'] as string), body);
    return true;
  }
  if (url.pathname.startsWith('/streams/')) {
    serveStream(res, url.pathname);
    return true;
  }
  return false;
}

export function fixtureServer(): Plugin {
  return {
    name: 'e2e-fixture-server',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!handle(req, res)) next();
      });
    },
  };
}
