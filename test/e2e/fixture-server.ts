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

// ---- low-latency HLS origin -------------------------------------------------
// LL-HLS (RFC 8216bis) over one fragmented MP4 with a fragment every second
// and a key frame every four (gen-streams.sh ll_flavor): 4 s segments of four
// 1 s parts. The stream plays out live from the t0 in the path, with a
// prelude so a window exists at boot. Playlist requests block on _HLS_msn and
// _HLS_part, _HLS_skip=YES gets a delta update, and a part request blocks
// until the part exists, as a preload hint needs.

const LL = { prelude: 24, window: 10, partsPerSegment: 4, withParts: 3, skipUntil: 24 };

interface LlSource {
  readonly bytes: Buffer;
  readonly init: Buffer;
  /** Byte ranges of each moof+mdat pair, one per second. */
  readonly fragments: ReadonlyArray<{ start: number; end: number }>;
  readonly codec: string;
}

const llCache = new Map<string, LlSource>();

function llSource(flavor: string): LlSource {
  let source = llCache.get(flavor);
  if (source === undefined) {
    const dir = join(STREAMS, `${flavor}-ll`);
    const bytes = readFileSync(join(dir, 'stream.mp4'));
    const fragments: Array<{ start: number; end: number }> = [];
    let initEnd = 0;
    let at = 0;
    while (at + 8 <= bytes.length) {
      const size = bytes.readUInt32BE(at);
      const type = bytes.toString('latin1', at + 4, at + 8);
      if (type === 'moof') {
        if (initEnd === 0) initEnd = at;
        fragments.push({ start: at, end: at + size });
      } else if (type === 'mdat') {
        const last = fragments[fragments.length - 1];
        if (last !== undefined) last.end = at + size;
      }
      at += size;
    }
    source = {
      bytes,
      init: bytes.subarray(0, initEnd),
      fragments,
      codec: readFileSync(join(dir, 'codec.txt'), 'utf8').trim(),
    };
    llCache.set(flavor, source);
  }
  return source;
}

/** Fragments published by now. */
function llAvailable(source: LlSource, t0: number): number {
  const elapsed = (Date.now() - t0) / 1000 + LL.prelude;
  return Math.min(source.fragments.length, Math.max(0, Math.floor(elapsed)));
}

function llPlaylist(source: LlSource, t0: number, skip: boolean): string {
  const available = llAvailable(source, t0);
  const per = LL.partsPerSegment;
  const complete = Math.floor(available / per);
  const ended = available >= source.fragments.length;
  const trailing = ended ? 0 : available % per;
  const oldest = Math.max(0, complete - LL.window);
  // RFC 8216bis §6.2.5.1: a delta update leaves out the segments that end
  // more than CAN-SKIP-UNTIL seconds before the end of the playlist.
  let skipped = 0;
  if (skip) {
    while (
      oldest + skipped < complete &&
      (oldest + skipped + 1) * per <= available - LL.skipUntil
    ) {
      skipped += 1;
    }
  }
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:9',
    `#EXT-X-TARGETDURATION:${per}`,
    `#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=3.0,CAN-SKIP-UNTIL=${LL.skipUntil}.0`,
    '#EXT-X-PART-INF:PART-TARGET=1.0',
    `#EXT-X-MEDIA-SEQUENCE:${oldest}`,
    '#EXT-X-MAP:URI="init.mp4"',
  ];
  if (skipped > 0) lines.push(`#EXT-X-SKIP:SKIPPED-SEGMENTS=${skipped}`);
  const first = oldest + skipped;
  const epoch = t0 - LL.prelude * 1000;
  lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(epoch + first * per * 1000).toISOString()}`);
  const parts = (msn: number, count: number) => {
    for (let p = 0; p < count; p += 1) {
      const flag = p === 0 ? ',INDEPENDENT=YES' : '';
      lines.push(`#EXT-X-PART:DURATION=1.0,URI="part-${msn}.${p}.m4s"${flag}`);
    }
  };
  for (let msn = first; msn < complete; msn += 1) {
    if (!ended && msn >= complete - LL.withParts) parts(msn, per);
    lines.push(`#EXTINF:${per}.0,`, `seg-${msn}.m4s`);
  }
  if (ended) {
    lines.push('#EXT-X-ENDLIST');
  } else {
    parts(complete, trailing);
    lines.push(`#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part-${complete}.${trailing}.m4s"`);
  }
  return lines.join('\n');
}

/** Waits until fragment `index` is published; false when it never will be soon. */
async function llWait(
  source: LlSource,
  t0: number,
  index: number,
  slack: number,
): Promise<boolean> {
  if (index >= source.fragments.length) return false;
  if (index > llAvailable(source, t0) + slack) return false;
  while (index >= llAvailable(source, t0)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

function llFragments(res: ServerResponse, source: LlSource, from: number, to: number): void {
  const start = (source.fragments[from] as { start: number }).start;
  const end = (source.fragments[to] as { end: number }).end;
  res.writeHead(200, { 'content-type': MIME['.m4s'] as string, 'cache-control': 'no-store' });
  res.end(source.bytes.subarray(start, end));
}

// ---- low-latency DASH origin ----------------------------------------------
// The same stream as chunked CMAF (DASH-IF IOP low-latency): 4 s segments,
// each sent as its four 1 s chunks are published. @availabilityTimeOffset
// lets a client ask for a segment three seconds before it ends.
//
// `skew` sets this server's clock that many seconds ahead of the real one:
// the MPD writes availabilityStartTime and the UTCTiming date in server
// time, so only a client that reads UTCTiming finds the live edge. `utc`
// picks the scheme: `direct` (the date in the MPD) or `head` (the Date
// header of /ll/time).

function llMpd(source: LlSource, t0: number, skew: number, utc: string): string {
  const serverNow = Date.now() + skew * 1000;
  const start = new Date(t0 - LL.prelude * 1000 + skew * 1000).toISOString();
  const timing =
    utc === 'head'
      ? '<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-head:2014" value="/ll/time?skew=' +
        `${skew}"/>`
      : `<UTCTiming schemeIdUri="urn:mpeg:dash:utc:direct:2014" value="${new Date(serverNow).toISOString()}"/>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="${start}"
  minimumUpdatePeriod="PT30S" timeShiftBufferDepth="PT30S" maxSegmentDuration="PT4S"
  minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <ServiceDescription id="0">
    <Latency referenceId="0" target="3000" max="9000" min="2000"/>
    <PlaybackRate min="0.96" max="1.04"/>
  </ServiceDescription>
  <Period id="p0" start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
      <SegmentTemplate timescale="1000" duration="${LL.partsPerSegment * 1000}" startNumber="0"
        availabilityTimeOffset="${LL.partsPerSegment - 1}" availabilityTimeComplete="false"
        initialization="init.mp4" media="dash-$Number$.m4s"/>
      <Representation id="v" codecs="${source.codec}" bandwidth="200000" width="320" height="180"/>
    </AdaptationSet>
  </Period>
  ${timing}
</MPD>`;
}

/** Sends a segment's chunks as they are published, each in one write. */
async function llChunked(
  res: ServerResponse,
  source: LlSource,
  t0: number,
  segment: number,
): Promise<void> {
  const first = segment * LL.partsPerSegment;
  if (!(await llWait(source, t0, first, LL.partsPerSegment))) {
    res.writeHead(404);
    res.end('not yet');
    return;
  }
  res.writeHead(200, { 'content-type': MIME['.m4s'] as string, 'cache-control': 'no-store' });
  for (let index = first; index < first + LL.partsPerSegment; index += 1) {
    if (!(await llWait(source, t0, index, LL.partsPerSegment))) break;
    const fragment = source.fragments[index] as { start: number; end: number };
    res.write(source.bytes.subarray(fragment.start, fragment.end));
  }
  res.end();
}

async function handleLl(url: URL, res: ServerResponse): Promise<boolean> {
  if (url.pathname === '/ll/time') {
    const skew = Number(url.searchParams.get('skew')) || 0;
    res.writeHead(200, {
      date: new Date(Date.now() + skew * 1000).toUTCString(),
      'cache-control': 'no-store',
    });
    res.end();
    return true;
  }
  const match = /^\/ll\/(h264|vp9)\/(\d+)\/(.+)$/.exec(url.pathname);
  if (match === null) return false;
  const [, flavor, t0Text, name] = match as unknown as [string, string, string, string];
  const t0 = Number(t0Text);
  const source = llSource(flavor);
  const per = LL.partsPerSegment;
  if (name === 'master.m3u8') {
    text(
      res,
      MIME['.m3u8'] as string,
      [
        '#EXTM3U',
        '#EXT-X-VERSION:9',
        `#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x180,CODECS="${source.codec}"`,
        'media.m3u8',
      ].join('\n'),
    );
    return true;
  }
  if (name === 'media.m3u8') {
    const msn = url.searchParams.get('_HLS_msn');
    if (msn !== null) {
      const part = url.searchParams.get('_HLS_part');
      const index = Number(msn) * per + (part === null ? per - 1 : Number(part));
      // RFC 8216bis §6.2.5.2: a request too far ahead is a client error.
      if (!(await llWait(source, t0, index, 3 * per))) {
        res.writeHead(400);
        res.end('too far ahead');
        return true;
      }
    }
    text(
      res,
      MIME['.m3u8'] as string,
      llPlaylist(source, t0, url.searchParams.get('_HLS_skip') === 'YES'),
    );
    return true;
  }
  if (name === 'manifest.mpd') {
    const skew = Number(url.searchParams.get('skew')) || 0;
    const utc = url.searchParams.get('utc') ?? 'direct';
    text(res, MIME['.mpd'] as string, llMpd(source, t0, skew, utc));
    return true;
  }
  const chunked = /^dash-(\d+)\.m4s$/.exec(name);
  if (chunked !== null) {
    await llChunked(res, source, t0, Number(chunked[1]));
    return true;
  }
  if (name === 'init.mp4') {
    res.writeHead(200, { 'content-type': MIME['.mp4'] as string, 'cache-control': 'no-store' });
    res.end(source.init);
    return true;
  }
  const part = /^part-(\d+)\.(\d+)\.m4s$/.exec(name);
  if (part !== null) {
    const index = Number(part[1]) * per + Number(part[2]);
    // A preload hint names the next part: hold the request until it exists.
    if (!(await llWait(source, t0, index, 2))) {
      res.writeHead(404);
      res.end('no such part');
      return true;
    }
    llFragments(res, source, index, index);
    return true;
  }
  const segment = /^seg-(\d+)\.m4s$/.exec(name);
  if (segment !== null) {
    const first = Number(segment[1]) * per;
    if (first + per > llAvailable(source, t0)) {
      res.writeHead(404);
      res.end('not yet');
      return true;
    }
    llFragments(res, source, first, first + per - 1);
    return true;
  }
  res.writeHead(404);
  res.end('not found');
  return true;
}

// ---- license server -------------------------------------------------------
// A ClearKey license server behind a rotating bearer token. POST
// /license/token issues a new token and voids the old one; POST
// /license/clearkey answers the CDM's JSON request with the key, for the
// current token only. `fail=N` answers 503 to the first N license requests.
// State is per `id`, so each test has its own server.

const LICENSE_KEYS: Record<string, string> = {
  nrQFDeRLSAKTLifXUIPiZg: 'ABEiM0RVZneImaq7zN3u_w',
};
const licenseState = new Map<string, { token: number; failed: number; calls: number }>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleLicense(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = url.searchParams.get('id') ?? '';
  const state = licenseState.get(id) ?? { token: 0, failed: 0, calls: 0 };
  licenseState.set(id, state);
  if (url.pathname === '/license/token') {
    state.token += 1;
    text(res, 'text/plain', `token-${id}-${state.token}`);
    return;
  }
  if (url.pathname === '/license/calls') {
    text(res, 'application/json', JSON.stringify(state));
    return;
  }
  state.calls += 1;
  const body = await readBody(req);
  if (state.failed < Number(url.searchParams.get('fail') ?? 0)) {
    state.failed += 1;
    res.writeHead(503);
    res.end('busy');
    return;
  }
  if (state.token === 0 || req.headers.authorization !== `Bearer token-${id}-${state.token}`) {
    res.writeHead(401);
    res.end('token expired');
    return;
  }
  const kids = (JSON.parse(body) as { kids?: string[] }).kids ?? [];
  const keys = kids
    .filter((kid) => LICENSE_KEYS[kid] !== undefined)
    .map((kid) => ({ kty: 'oct', kid, k: LICENSE_KEYS[kid] }));
  text(res, 'application/json', JSON.stringify({ keys, type: 'temporary' }));
}

// ---- routing --------------------------------------------------------------

function text(res: ServerResponse, contentType: string, body: string): void {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

function serveStream(
  res: ServerResponse,
  pathname: string,
  headers: Record<string, string> = {},
): void {
  const path = normalize(join(STREAMS, pathname.slice('/streams/'.length)));
  if (!path.startsWith(normalize(STREAMS)) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    ...headers,
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
  // The corpus with CMSD (CTA-5006): the edge estimates 5 Mbps and caps the
  // bitrate at 300 kbps, exposed as a cross-origin CDN would.
  const cmsdMatch = /^\/cmsd(\/streams\/.*)$/.exec(url.pathname);
  if (cmsdMatch !== null) {
    serveStream(res, cmsdMatch[1] as string, {
      'CMSD-Dynamic': '"edge";etp=5000;mb=300',
      'Access-Control-Expose-Headers': 'CMSD-Dynamic',
    });
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
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname.startsWith('/ll/')) {
          handleLl(url, res).then(
            (handled) => {
              if (!handled) next();
            },
            (error: unknown) => next(error),
          );
          return;
        }
        if (url.pathname.startsWith('/license/')) {
          handleLicense(url, req, res).catch((error: unknown) => next(error));
          return;
        }
        if (!handle(req, res)) next();
      });
    },
  };
}
