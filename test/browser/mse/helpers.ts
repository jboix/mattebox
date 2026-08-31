import type { Fact, Message } from '../../../src/index.js';
import type { KernelBus } from '../../../src/kernel/bus.js';
import { createBus } from '../../../src/kernel/bus.js';
import type { EffectRunner } from '../../../src/kernel/effects.js';
import { createEffectRunner } from '../../../src/kernel/effects.js';
import type { MseController, MseControllerOptions } from '../../../src/kernel/mse.js';
import { createMseController } from '../../../src/kernel/mse.js';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';

export const VIDEO_BASE = 'video/mp4; codecs="avc1.42c01e"';
export const VIDEO_MAIN = 'video/mp4; codecs="avc1.4d401e"';
export const VIDEO_VP9 = 'video/mp4; codecs="vp09.00.30.08"';
export const VIDEO_AV1 = 'video/mp4; codecs="av01.0.04M.08"';
export const AUDIO_AAC = 'audio/mp4; codecs="mp4a.40.2"';

export interface VideoProfile {
  readonly label: string;
  readonly type: string;
  readonly init: string;
  readonly seg: string;
  /** changeType partner: a different codec the same buffer switches to. */
  readonly altType: string;
  readonly altInit: string;
  readonly altSeg: string;
}

const H264_PROFILE: VideoProfile = {
  label: 'h264',
  type: VIDEO_BASE,
  init: 'init-v-base.mp4',
  seg: 'seg-v-base-1.m4s',
  altType: VIDEO_MAIN,
  altInit: 'init-v-main.mp4',
  altSeg: 'seg-v-main-1.m4s',
};

const VP9_PROFILE: VideoProfile = {
  label: 'vp9',
  type: VIDEO_VP9,
  init: 'init-v-vp9.mp4',
  seg: 'seg-v-vp9-1.m4s',
  altType: VIDEO_AV1,
  altInit: 'init-v-av1.mp4',
  altSeg: 'seg-v-av1-1.m4s',
};

/**
 * The first codec this browser's MSE accepts. Playwright's chromium ships
 * no H.264 decoder, so it exercises the suite through VP9 instead.
 */
export function pickVideoProfile(): VideoProfile | null {
  if (MediaSource.isTypeSupported(H264_PROFILE.type)) return H264_PROFILE;
  if (MediaSource.isTypeSupported(VP9_PROFILE.type)) return VP9_PROFILE;
  return null;
}

const fixtureCache = new Map<string, ArrayBuffer>();

/** Loads a binary fixture through the vitest browser server. */
export async function fixture(name: string): Promise<ArrayBuffer> {
  const cached = fixtureCache.get(name);
  if (cached !== undefined) return cached;
  const url = new URL(`../../fixtures/segments/${name}`, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load fixture ${name}: ${res.status}`);
  const bytes = await res.arrayBuffer();
  fixtureCache.set(name, bytes);
  return bytes;
}

/** Polls with the real clock. No fake timers in tier 3; real timing is the point. */
export async function waitFor(
  pred: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export interface Stack {
  readonly bus: KernelBus;
  readonly runner: EffectRunner;
  readonly controller: MseController;
  readonly el: HTMLVideoElement;
  facts(type: Message['type']): readonly Message[];
  hasFact(type: Fact['type']): boolean;
}

/** A real bus + runner + mse controller wired the way the facade will wire them. */
export function createStack(options: Partial<MseControllerOptions> = {}): Stack {
  const bus = createBus({ reducer: createReducer(), initial: initialState() });
  const runner = createEffectRunner();
  const controller = createMseController({ absorb: (fact) => bus.absorb(fact), ...options });
  controller.registerHandlers(runner);
  runner.register('emit', (effect) => {
    bus.emitEvent(effect.event, effect.payload);
    return undefined;
  });
  bus.setEffectSink((effects) => runner.run(effects));

  const el = document.createElement('video');
  el.muted = true;

  return {
    bus,
    runner,
    controller,
    el,
    facts(type) {
      return bus
        .trace()
        .map((entry) => entry.msg)
        .filter((msg) => msg.type === type);
    },
    hasFact(type) {
      return bus.trace().some((entry) => entry.msg.type === type);
    },
  };
}

export async function attachAndOpen(stack: Stack): Promise<void> {
  stack.controller.attach(stack.el);
  await waitFor(() => stack.controller.readyState() === 'open', 'sourceopen');
}

export async function createBufferAndWait(stack: Stack, sbId: string, type: string): Promise<void> {
  stack.runner.run([{ kind: 'createSourceBuffer', sbId, codecs: type }]);
  await waitFor(
    () => stack.hasFact('SOURCEBUFFER_CREATED') || stack.hasFact('SOURCEBUFFER_ERROR'),
    `source buffer for ${type}`,
  );
}
