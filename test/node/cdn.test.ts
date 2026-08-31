import { describe, expect, it } from 'vitest';
import dashGlobal from '../../cdn/dash.js';
import dashDrmGlobal from '../../cdn/dash-drm.js';
import dualGlobal from '../../cdn/dual.js';
import dualDrmGlobal from '../../cdn/dual-drm.js';
import dualTsGlobal from '../../cdn/dual-ts.js';
import dualTsDrmGlobal from '../../cdn/dual-ts-drm.js';
import fullGlobal from '../../cdn/full.js';
import hlsGlobal from '../../cdn/hls.js';
import hlsDrmGlobal from '../../cdn/hls-drm.js';
import hlsTsGlobal from '../../cdn/hls-ts.js';
import hlsTsDrmGlobal from '../../cdn/hls-ts-drm.js';

// The CDN entries evaluate in node with no document: the script URL is
// unknown and the Worker path stays unset, which is the fallback path.
describe('the CDN globals', () => {
  const globals = {
    hls: hlsGlobal,
    'hls-drm': hlsDrmGlobal,
    'hls-ts': hlsTsGlobal,
    'hls-ts-drm': hlsTsDrmGlobal,
    dash: dashGlobal,
    'dash-drm': dashDrmGlobal,
    dual: dualGlobal,
    'dual-drm': dualDrmGlobal,
    'dual-ts': dualTsGlobal,
    'dual-ts-drm': dualTsDrmGlobal,
    full: fullGlobal,
  } as const;

  for (const [name, global] of Object.entries(globals)) {
    it(`${name}: the factory, the preset, from, and every preset stage hang off the global`, () => {
      expect(global.preset.presetName).toBe(name);
      // Hand composition is the raw factory: no preset stages sneak in.
      expect([...global({}).capabilities()]).toEqual([]);
      const engine = global.preset();
      expect(engine.error).toBeNull();
      const presetNames = global.preset.stages().map((s) => s.name);
      expect(presetNames.length).toBeGreaterThan(0);
      expect(typeof global.from).toBe('function');
      // Every stage the preset composes is also reachable as a factory.
      const factories = Object.values(global).filter((v) => typeof v === 'function');
      const factoryNames = factories
        .map((f) => {
          try {
            return (f as () => { name?: string })().name;
          } catch {
            return undefined;
          }
        })
        .filter((n): n is string => n !== undefined);
      for (const stageName of presetNames) expect(factoryNames).toContain(stageName);
    });
  }

  it('a -ts bundle merges an override for ts-transmux last, so the caller wins', () => {
    for (const global of [fullGlobal, hlsTsGlobal, dualTsDrmGlobal]) {
      const own = global.tsTransmux({ workerUrl: 'https://cdn.example/w.js' });
      const stages = global.preset.stages({ stages: [own] });
      expect(stages.filter((s) => s.name === 'ts-transmux')).toEqual([own]);
    }
  });
});
