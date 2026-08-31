// The page the E2E suite drives: a real engine on a real element, loading
// the flavor this browser can decode, HLS or DASH by query. Both protocol
// stages ride in one composition: two parsers, one engine. `abr=1` adds
// the abr stage, `capsize=1` the element-size cap, and `profile=` shapes
// segment throughput through the transport's own fetchImpl seam.

import packedAudio from '../../src/containers/packed-audio/index.js';
import tsTransmux from '../../src/containers/ts-transmux/index.js';
import { mattebox } from '../../src/index.js';
import dashCmaf from '../../src/protocols/dash-cmaf/index.js';
import dashLive from '../../src/protocols/dash-live/index.js';
import hlsCmaf from '../../src/protocols/hls-cmaf/index.js';
import hlsLive from '../../src/protocols/hls-live/index.js';
import abr from '../../src/stages/abr/index.js';
import abrCapSize from '../../src/stages/abr-cap-size/index.js';
import altAudio from '../../src/stages/alt-audio/index.js';
import cmafTiming from '../../src/stages/cmaf-timing/index.js';
import codecSwitch from '../../src/stages/codec-switch/index.js';
import contentSteering from '../../src/stages/content-steering/index.js';
import emeCenc from '../../src/stages/eme-cenc/index.js';
import emeCore from '../../src/stages/eme-core/index.js';
import metaId3 from '../../src/stages/meta-id3/index.js';
import nalScan from '../../src/stages/nal-scan/index.js';
import pdt from '../../src/stages/pdt/index.js';
import recovery from '../../src/stages/recovery/index.js';
import textCea608 from '../../src/stages/text-cea608/index.js';
import textWebvtt from '../../src/stages/text-webvtt/index.js';
import textWebvttSegmented from '../../src/stages/text-webvtt-segmented/index.js';

const video = document.createElement('video');
video.muted = true;
video.controls = true;
video.style.width = '480px';
document.body.appendChild(video);

const params = new URLSearchParams(location.search);
const flavor = MediaSource.isTypeSupported('video/mp4; codecs="avc1.42c01e"') ? 'h264' : 'vp9';
const proto = params.get('src') ?? 'hls';
const sources: Record<string, string> = {
  hls: `/streams/${flavor}/master.m3u8`,
  dash: `/streams/${flavor}-dash/manifest.mpd`,
  'hls-live': `/live/${flavor}/master.m3u8?t0=${Date.now()}`,
  'dash-live': `/live/${flavor}/live.mpd?t0=${Date.now()}`,
  steer: `/steer/${flavor}/master.m3u8`,
  // The legacy families: a muxed MPEG-TS stream and a packed-audio stream,
  // both H.264/AAC and playable only where ts-transmux is loaded.
  ts: '/streams/ts/master.m3u8',
  aac: '/streams/aac/master.m3u8',
};
const source = sources[proto] ?? (sources.hls as string);

const profile = params.get('profile');
const started = Date.now();

function profileBps(): number {
  const elapsed = (Date.now() - started) / 1000;
  switch (profile) {
    case 'step-down':
      return elapsed < 8 ? 2_500_000 : 250_000;
    case 'sawtooth':
      return elapsed % 16 < 8 ? 2_500_000 : 250_000;
    case 'collapse':
      return elapsed < 8 ? 2_500_000 : elapsed < 20 ? 100_000 : 2_500_000;
    default:
      return 0;
  }
}

// Injected failures: URLs containing `fail` start 404ing after
// `failAfter` seconds, through the transport seam like everything else.
const failMatch = params.get('fail');
const failAfter = Number(params.get('failAfter') ?? 0);

// Chunked pacing: the transfer re-reads the profile every slice, so an
// in-flight segment slows down and speeds up as a real network would.
async function shapedFetch(url: string, init: RequestInit): Promise<Response> {
  if (failMatch !== null && url.includes(failMatch) && (Date.now() - started) / 1000 >= failAfter) {
    return new Response(null, { status: 404 });
  }
  const response = await fetch(url, init);
  if (profile === null || !/\.(m4s|mp4)(\?|$)/.test(url)) return response;
  let remaining = (await response.clone().arrayBuffer()).byteLength;
  while (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    remaining -= (profileBps() / 8) * 0.25;
  }
  return response;
}

const stages = [
  hlsCmaf(),
  dashCmaf(),
  textWebvtt(),
  textWebvttSegmented(),
  hlsLive(),
  dashLive(),
  pdt(),
  recovery({ readmitAfterSeconds: 60 }),
  contentSteering(),
  codecSwitch(),
  altAudio(),
  // Part of every preset's base: live CMAF whose tfdt carries a broadcast
  // clock needs it, VOD is untouched, so the suite runs the normalized
  // append path the presets ship.
  cmafTiming(),
];
// The legacy container family loads for the TS and packed-audio sources.
// It sniffs per segment, so it passes CMAF fMP4 straight through, but it is
// gated here to keep the CMAF tests measuring the CMAF append path.
if (proto === 'ts' || proto === 'aac' || params.get('ts') === '1') {
  stages.push(tsTransmux(), packedAudio(), metaId3());
  // Captions come off the TS SEI through ts-transmux; nal-scan is the fMP4
  // route, composed here so its transform is exercised on the same content.
  if (params.get('cc') === '1') stages.push(nalScan(), textCea608());
}
if (params.get('abr') === '1') stages.push(abr());
if (params.get('capsize') === '1') stages.push(abrCapSize());
if (params.get('drm') === '1') {
  // ClearKey with a known KID -> KEY; the encrypted-event test drives it.
  stages.push(emeCore({ clearKeys: { nrQFDeRLSAKTLifXUIPiZg: 'ABEiM0RVZneImaq7zN3u_w' } }));
  stages.push(emeCenc());
}

const reactive = profile !== null || params.get('abr') === '1' || failMatch !== null;
const engine = mattebox({
  stages,
  // A short goal keeps tier-4 tests reactive: fewer prefetched segments
  // between a change and the moment its consequences reach the playhead.
  ...(reactive ? { config: { bufferGoalSeconds: 12 } } : {}),
  ...(profile !== null || failMatch !== null ? { transport: { fetchImpl: shapedFetch } } : {}),
});

declare global {
  interface Window {
    engine: ReturnType<typeof mattebox>;
    video: HTMLVideoElement;
    flavor: string;
    ready: Promise<void>;
    switchLog: Array<{ t: number; id: string }>;
    constraintLog: Array<{ t: number; sources: string[] }>;
    /** An `encrypted` event carrying init data, for the DRM specs. */
    encryptedEvent: (initDataType: string, initData: ArrayBuffer) => Event;
  }
}

// WebKit does not expose the MediaEncryptedEvent constructor; a plain Event
// with the two fields eme-core reads is what its own dispatch looks like.
window.encryptedEvent = (initDataType, initData) =>
  typeof MediaEncryptedEvent === 'function'
    ? new MediaEncryptedEvent('encrypted', { initDataType, initData })
    : Object.assign(new Event('encrypted'), { initDataType, initData });

window.switchLog = [];
window.constraintLog = [];
setInterval(() => {
  const t = (Date.now() - started) / 1000;
  const id = engine.quality.active?.id;
  const lastSwitch = window.switchLog[window.switchLog.length - 1];
  if (id !== undefined && id !== lastSwitch?.id) {
    window.switchLog.push({ t, id });
  }
  const sources = [...engine.quality.constraints.keys()].sort();
  const lastSources = window.constraintLog[window.constraintLog.length - 1];
  if (JSON.stringify(sources) !== JSON.stringify(lastSources?.sources ?? null)) {
    window.constraintLog.push({ t, sources });
  }
}, 100);

window.engine = engine;
window.video = video;
window.flavor = flavor;
window.ready = engine.attach(video).then(() => {
  engine.load(source);
});
