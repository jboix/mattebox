import { describe, expect, it } from 'vitest';
import dash from '../../src/presets/dash/index.js';
import dashDrm from '../../src/presets/dash-drm/index.js';
import { definePreset, mergeStages } from '../../src/presets/define.js';
import dual from '../../src/presets/dual/index.js';
import dualDrm from '../../src/presets/dual-drm/index.js';
import dualTs from '../../src/presets/dual-ts/index.js';
import dualTsDrm from '../../src/presets/dual-ts-drm/index.js';
import full from '../../src/presets/full/index.js';
import hls from '../../src/presets/hls/index.js';
import hlsDrm from '../../src/presets/hls-drm/index.js';
import hlsTs from '../../src/presets/hls-ts/index.js';
import hlsTsDrm from '../../src/presets/hls-ts-drm/index.js';
import kernel from '../../src/presets/kernel/index.js';
import { localThroughputStorage } from '../../src/presets/storage.js';
import abr from '../../src/stages/abr/index.js';
import type { Stage } from '../../src/types/stage.js';

function stub(name: string, requires: string[] = []): Stage {
  return { name, requires, install: () => undefined };
}

const HLS = ['hls-cmaf', 'hls-live', 'pdt', 'aes-128'];
const DASH = ['dash-cmaf', 'dash-live'];
const BASE = [
  'abr',
  'abr-cap-size',
  'abr-persist',
  'recovery',
  'content-steering',
  'codec-switch',
  'alt-audio',
  'text-webvtt',
  'text-webvtt-segmented',
  'cmaf-timing',
];
const TS = ['ts-transmux', 'packed-audio', 'nal-scan', 'text-cea608', 'meta-id3'];
const DRM = ['eme-core', 'eme-cenc', 'eme-fairplay'];
const ACCESSORIES = ['mp4-box', 'codec-probe', 'cmcd', 'thumbnails'];

const MATRIX: ReadonlyArray<[typeof kernel, readonly string[]]> = [
  [kernel, []],
  [hls, [...HLS, ...BASE]],
  [hlsDrm, [...HLS, ...BASE, ...DRM]],
  [hlsTs, [...HLS, ...BASE, ...TS]],
  [hlsTsDrm, [...HLS, ...BASE, ...TS, ...DRM]],
  [dash, [...DASH, ...BASE]],
  [dashDrm, [...DASH, ...BASE, ...DRM]],
  [dual, [...HLS, ...DASH, ...BASE]],
  [dualDrm, [...HLS, ...DASH, ...BASE, ...DRM]],
  [dualTs, [...HLS, ...DASH, ...BASE, ...TS]],
  [dualTsDrm, [...HLS, ...DASH, ...BASE, ...TS, ...DRM]],
  [full, [...HLS, ...DASH, ...BASE, ...TS, ...DRM, ...ACCESSORIES]],
];

describe('the preset matrix', () => {
  for (const [preset, expected] of MATRIX) {
    it(`${preset.presetName} composes its line, the base, and its tiers, in order`, () => {
      expect(preset.stages().map((s) => s.name)).toEqual(expected);
      const engine = preset();
      expect(engine.media).toBeNull();
      expect(engine.error).toBeNull();
    });
  }

  it('full carries every stage of the catalogue, each name once', () => {
    const names = full.stages().map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(28);
  });

  it('every call returns fresh stage instances', () => {
    const [a] = dual.stages();
    const [b] = dual.stages();
    expect(a).not.toBe(b);
    expect(a?.name).toBe(b?.name);
  });

  it('a line accepts the manifest types of its adapters and no other', () => {
    expect(hls().accepts('application/vnd.apple.mpegurl')).toBe(true);
    expect(hls().accepts('application/dash+xml')).toBe(false);
    expect(dash().accepts('application/dash+xml')).toBe(true);
    expect(dash().accepts('audio/mpegurl')).toBe(false);
    expect(dual().accepts('application/dash+xml')).toBe(true);
    expect(dual().accepts('audio/mpegurl')).toBe(true);
  });
});

describe('the merge rule', () => {
  const defaults = () => [stub('a'), stub('b'), stub('c')];

  it('a matching name replaces in place, any other appends after', () => {
    const replacement = stub('b');
    const extra = stub('z');
    const merged = mergeStages(defaults(), { stages: [extra, replacement] });
    expect(merged.map((s) => s.name)).toEqual(['a', 'b', 'c', 'z']);
    expect(merged[1]).toBe(replacement);
    expect(merged[3]).toBe(extra);
  });

  it('without drops by name; a replacement for a dropped name still appends', () => {
    const merged = mergeStages(defaults(), { without: ['a', 'c'], stages: [stub('c')] });
    expect(merged.map((s) => s.name)).toEqual(['b', 'c']);
  });

  it('the last override under one name wins', () => {
    const first = stub('b');
    const last = stub('b');
    const merged = mergeStages(defaults(), { stages: [first, last] });
    expect(merged[1]).toBe(last);
  });

  it('no options returns the defaults untouched', () => {
    expect(mergeStages(defaults()).map((s) => s.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('a preset factory', () => {
  it('passes a configured instance through under its name', () => {
    const configured = abr({ upBufferSeconds: 12 });
    const stages = hls.stages({ stages: [configured] });
    expect(stages.map((s) => s.name)).toEqual([...HLS, ...BASE]);
    expect(stages[HLS.length]).toBe(configured);
  });

  it('forwards kernel config and transport options to the engine', () => {
    const engine = dual({ config: { bufferGoalSeconds: 42 } });
    expect(engine.stats.snapshot().scheduling.bufferGoal).toBe(42);
  });

  it('removing a stage another one requires fails at construction, by name', () => {
    expect(() => hls({ without: ['abr'] })).toThrowError(/'abr-persist' requires 'abr'/);
  });

  it('carries its name and lists its stages', () => {
    const preset = definePreset('mine', () => [stub('x')]);
    expect(preset.presetName).toBe('mine');
    expect(preset.stages({ stages: [stub('y')] }).map((s) => s.name)).toEqual(['x', 'y']);
    expect([...preset().capabilities()]).toEqual([]);
  });
});

describe('the default throughput storage', () => {
  it('remembers nothing where localStorage is absent or throwing, and never throws', () => {
    const storage = localThroughputStorage();
    expect(storage.get()).toBeNull();
    expect(() => storage.set(1_000_000)).not.toThrow();

    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    Object.defineProperty(globalThis, 'localStorage', { value: broken, configurable: true });
    try {
      expect(storage.get()).toBeNull();
      expect(() => storage.set(1)).not.toThrow();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('round-trips a positive figure through a working storage', () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
      },
      configurable: true,
    });
    try {
      const storage = localThroughputStorage('k');
      storage.set(2_500_000.7);
      expect(store.get('k')).toBe('2500001');
      expect(storage.get()).toBe(2_500_001);
      store.set('k', 'garbage');
      expect(storage.get()).toBeNull();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
