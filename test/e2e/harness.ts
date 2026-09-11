// The in-page harness the E2E suite drives: a real engine on a real element
// in the Vitest browser tester, loading the flavor this browser can decode,
// HLS or DASH by option. Both protocol stages ride in one composition: two
// parsers, one engine. `abr` adds the abr stage, `capsize` the element-size
// cap, and `profile` shapes segment throughput through the transport's own
// fetchImpl seam. The tests hold the engine directly: no window globals, no
// serialisation boundary.

import packedAudio from '../../src/containers/packed-audio/index.js';
import tsTransmux from '../../src/containers/ts-transmux/index.js';
import type { Stage } from '../../src/index.js';
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

export type Source = 'hls' | 'dash' | 'hls-live' | 'dash-live' | 'steer' | 'ts' | 'aac';
export type Profile = 'step-down' | 'sawtooth' | 'collapse';

export interface BootOptions {
  readonly src?: Source;
  readonly abr?: boolean;
  readonly capsize?: boolean;
  readonly drm?: boolean;
  /** Load the legacy container family for a CMAF source too. */
  readonly ts?: boolean;
  readonly cc?: boolean;
  readonly profile?: Profile;
  /** URLs containing this start 404ing after `failAfter` seconds. */
  readonly fail?: string;
  readonly failAfter?: number;
}

export interface Player {
  readonly engine: ReturnType<typeof mattebox>;
  readonly video: HTMLVideoElement;
  readonly flavor: 'h264' | 'vp9';
  readonly switchLog: Array<{ t: number; id: string }>;
  readonly constraintLog: Array<{ t: number; sources: string[] }>;
  /** Seconds since boot. */
  elapsed(): number;
}

/** The first codec flavor this browser's MSE decodes. Playwright's Chromium ships no H.264. */
export const flavor: 'h264' | 'vp9' = MediaSource.isTypeSupported('video/mp4; codecs="avc1.42c01e"')
  ? 'h264'
  : 'vp9';

/** True where the browser build decodes the H.264 Main profile the TS corpus uses. */
export const decodesH264 = MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d401e"');

/** True where the browser build ships Encrypted Media Extensions. Playwright's WebKit on Linux does not. */
export const hasEme = 'requestMediaKeySystemAccess' in navigator;

const sources: Record<Source, () => string> = {
  hls: () => `/streams/${flavor}/master.m3u8`,
  dash: () => `/streams/${flavor}-dash/manifest.mpd`,
  'hls-live': () => `/live/${flavor}/master.m3u8?t0=${Date.now()}`,
  'dash-live': () => `/live/${flavor}/live.mpd?t0=${Date.now()}`,
  steer: () => `/steer/${flavor}/master.m3u8`,
  // The legacy families: a muxed MPEG-TS stream and a packed-audio stream,
  // both H.264/AAC and playable only where ts-transmux is loaded.
  ts: () => '/streams/ts/master.m3u8',
  aac: () => '/streams/aac/master.m3u8',
};

const live: Array<{ player: Player; stop: () => void }> = [];

/** Composes an engine, attaches it to a fresh element in the document, and loads the source. */
export async function boot(options: BootOptions = {}): Promise<Player> {
  const src = options.src ?? 'hls';
  const video = document.createElement('video');
  video.muted = true;
  video.controls = true;
  video.style.width = '480px';
  document.body.appendChild(video);

  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;
  const profile = options.profile;

  function profileBps(): number {
    const t = elapsed();
    switch (profile) {
      case 'step-down':
        return t < 8 ? 2_500_000 : 250_000;
      case 'sawtooth':
        return t % 16 < 8 ? 2_500_000 : 250_000;
      case 'collapse':
        return t < 8 ? 2_500_000 : t < 20 ? 100_000 : 2_500_000;
      default:
        return 0;
    }
  }

  // Injected failures ride the transport seam like everything else, and
  // chunked pacing re-reads the profile every slice, so an in-flight
  // segment slows down and speeds up as a real network would.
  const failMatch = options.fail;
  const failAfter = options.failAfter ?? 0;
  async function shapedFetch(url: string, init: RequestInit): Promise<Response> {
    if (failMatch !== undefined && url.includes(failMatch) && elapsed() >= failAfter) {
      return new Response(null, { status: 404 });
    }
    const response = await fetch(url, init);
    if (profile === undefined || !/\.(m4s|mp4)(\?|$)/.test(url)) return response;
    let remaining = (await response.clone().arrayBuffer()).byteLength;
    while (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      remaining -= (profileBps() / 8) * 0.25;
    }
    return response;
  }

  const stages: Stage[] = [
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
  if (src === 'ts' || src === 'aac' || options.ts === true) {
    stages.push(tsTransmux(), packedAudio(), metaId3());
    // Captions come off the TS SEI through ts-transmux; nal-scan is the fMP4
    // route, composed here so its transform is exercised on the same content.
    if (options.cc === true) stages.push(nalScan(), textCea608());
  }
  if (options.abr === true) stages.push(abr());
  if (options.capsize === true) stages.push(abrCapSize());
  if (options.drm === true) {
    // ClearKey with a known KID -> KEY; the encrypted-event test drives it.
    stages.push(emeCore({ clearKeys: { nrQFDeRLSAKTLifXUIPiZg: 'ABEiM0RVZneImaq7zN3u_w' } }));
    stages.push(emeCenc());
  }

  const shaped = profile !== undefined || failMatch !== undefined;
  const reactive = shaped || options.abr === true;
  const engine = mattebox({
    stages,
    // A short goal keeps tier-4 tests reactive: fewer prefetched segments
    // between a change and the moment its consequences reach the playhead.
    // The suite reads the trace for recovery and steering events; the engine
    // keeps none unless asked.
    config: { traceCapacity: 500, ...(reactive ? { bufferGoalSeconds: 12 } : {}) },
    ...(shaped ? { transport: { fetchImpl: shapedFetch } } : {}),
  });

  const switchLog: Player['switchLog'] = [];
  const constraintLog: Player['constraintLog'] = [];
  const sampler = setInterval(() => {
    const t = elapsed();
    const id = engine.quality.active?.id;
    const lastSwitch = switchLog[switchLog.length - 1];
    if (id !== undefined && id !== lastSwitch?.id) switchLog.push({ t, id });
    const sources = [...engine.quality.constraints.keys()].sort();
    const lastSources = constraintLog[constraintLog.length - 1];
    if (JSON.stringify(sources) !== JSON.stringify(lastSources?.sources ?? null)) {
      constraintLog.push({ t, sources });
    }
  }, 100);

  const player: Player = { engine, video, flavor, switchLog, constraintLog, elapsed };
  live.push({
    player,
    stop: () => {
      clearInterval(sampler);
      video.remove();
    },
  });

  await engine.attach(video);
  engine.load(sources[src]());
  return player;
}

/** Tears down every engine this file booted. Register it as `afterEach`. */
export async function disposeAll(): Promise<void> {
  const players = live.splice(0);
  for (const { player, stop } of players) {
    await player.engine.detach();
    stop();
  }
}

/**
 * Starts playback. The play() promise rejects when a load fails or the
 * element is detached mid-flight; the tests assert on engine state and the
 * playhead, so the rejection carries nothing they need.
 */
export function start(player: Player): void {
  player.video.play().catch(() => undefined);
}

/** Starts playback and waits for the playhead to pass `seconds`. */
export async function play(player: Player, seconds = 1, timeoutMs = 15_000): Promise<void> {
  start(player);
  await until(() => player.video.currentTime > seconds, `currentTime > ${seconds}`, timeoutMs);
}

/** Polls with the real clock. No fake timers in tier 4; real timing is the point. */
export async function until(
  pred: () => boolean,
  label: string,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The names of every event the engine emitted, oldest first, off its trace. */
export function traceEvents(player: Player): string[] {
  return player.engine.stats
    .trace()
    .flatMap((e) => e.effects)
    .filter((f) => f.kind === 'emit')
    .map((f) => (f as { event: string }).event);
}

/**
 * An `encrypted` event carrying init data. WebKit does not expose the
 * MediaEncryptedEvent constructor; a plain Event with the two fields
 * eme-core reads is what its own dispatch looks like.
 */
export function encryptedEvent(initDataType: string, initData: ArrayBuffer): Event {
  return typeof MediaEncryptedEvent === 'function'
    ? new MediaEncryptedEvent('encrypted', { initDataType, initData })
    : Object.assign(new Event('encrypted'), { initDataType, initData });
}
