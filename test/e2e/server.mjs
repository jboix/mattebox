// The E2E fixture server: static files with streaming-correct MIME types.
// No dependencies, no cleverness.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 4173;

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.vtt': 'text/vtt',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.ts': 'video/mp2t',
  '.aac': 'audio/aac',
  '.js': 'text/javascript',
  '.html': 'text/html',
};

const PAGE = `<!doctype html>
<title>mattebox e2e</title>
<body style="background:#111;margin:0">
<script type="module" src="/app.js"></script>
</body>`;

// ---- live simulator -------------------------------------------------------
// A sliding window over the generated VOD segments, anchored at the t0 the
// test supplies, so every page load gets a fresh stream. HLS serves a bare
// media playlist; DASH serves a dynamic MPD over the same chunk files.

import { readFileSync } from 'node:fs';

const LIVE = { window: 5, duration: 4, total: 18 };
const dashMeta = new Map();

function dashInfo(flavor) {
  let meta = dashMeta.get(flavor);
  if (meta === undefined) {
    const mpd = readFileSync(
      join(ROOT, `test/fixtures/streams/${flavor}-dash/manifest.mpd`),
      'utf8',
    );
    meta = {
      codecs: /codecs="([^"]+)"/.exec(mpd)?.[1] ?? '',
      timescale: Number(/timescale="(\d+)"/.exec(mpd)?.[1] ?? 15360),
    };
    dashMeta.set(flavor, meta);
  }
  return meta;
}

function hlsCodecs(flavor) {
  let meta = dashMeta.get(`hls:${flavor}`);
  if (meta === undefined) {
    const master = readFileSync(join(ROOT, `test/fixtures/streams/${flavor}/master.m3u8`), 'utf8');
    meta = /CODECS="([^"]+)"/.exec(master)?.[1] ?? '';
    dashMeta.set(`hls:${flavor}`, meta);
  }
  return meta;
}

function liveHlsMaster(flavor, t0) {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=320x180,CODECS="${hlsCodecs(flavor)}"`,
    `/live/${flavor}/live.m3u8?t0=${t0}`,
  ].join('\n');
}

function steerMaster(flavor) {
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

function liveHls(flavor, t0) {
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

function liveDash(flavor, t0) {
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

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/player.html' || url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
    return;
  }
  if (url.pathname === '/steer/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ VERSION: 1, TTL: 300, 'PATHWAY-PRIORITY': ['a', 'b'] }));
    return;
  }
  const steerMatch = /^\/steer\/(h264|vp9)\/master\.m3u8$/.exec(url.pathname);
  if (steerMatch !== null) {
    res.writeHead(200, {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
    });
    res.end(steerMaster(steerMatch[1]));
    return;
  }
  // Pathway routes proxy to the real files; pathway a dies at segment 3,
  // which is what forces the failover the steering tests assert.
  const pwMatch = /^\/pw-(a|b)(\/.*)$/.exec(url.pathname);
  if (pwMatch !== null) {
    const [, pathway, rest] = pwMatch;
    if (pathway === 'a' && /seg-\w+-0(0[3-9]|[1-9]\d)\.m4s$/.test(rest)) {
      res.writeHead(404);
      res.end('pathway a is dead');
      return;
    }
    url.pathname = rest;
  }
  const liveMatch = /^\/live\/(h264|vp9)\/(live|master)\.(m3u8|mpd)$/.exec(url.pathname);
  if (liveMatch !== null) {
    const t0 = Number(url.searchParams.get('t0')) || Date.now();
    const [, flavor, name, kind] = liveMatch;
    const body =
      kind === 'mpd'
        ? liveDash(flavor, t0)
        : name === 'master'
          ? liveHlsMaster(flavor, t0)
          : liveHls(flavor, t0);
    res.writeHead(200, {
      'content-type': kind === 'm3u8' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(body);
    return;
  }
  // Any .js is a bundle chunk (app.js, the transmux Worker, its shared code):
  // served from the build dir so the real Worker path resolves in the browser.
  const mapped = url.pathname.endsWith('.js')
    ? join(ROOT, 'test/e2e/.build', url.pathname.slice(1))
    : url.pathname.startsWith('/streams/')
      ? join(ROOT, 'test/fixtures/streams', url.pathname.slice('/streams/'.length))
      : join(ROOT, url.pathname.slice(1));
  const path = normalize(mapped);
  if (!path.startsWith(normalize(ROOT)) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(res);
}).listen(PORT, () => {
  console.log(`e2e server on http://localhost:${PORT}`);
});
