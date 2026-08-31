import { expect, it } from 'vitest';
import { mattebox } from '../../src/index.js';
import hlsCmaf from '../../src/protocols/hls-cmaf/index.js';

// Tier 1/2 wiring proof over the real engine.
it('runs in a plain node environment with no DOM', () => {
  expect(typeof globalThis.document).toBe('undefined');
  const engine = mattebox({});
  expect(engine.media).toBeNull();
  expect([...engine.capabilities()]).toEqual([]);
  expect(engine.quality.renditions).toEqual([]);
  expect(engine.error).toBeNull();
});

it('accepts answers from the composed adapters, before attach', () => {
  const engine = mattebox({ stages: [hlsCmaf()] });
  expect(engine.accepts('application/vnd.apple.mpegurl')).toBe(true);
  expect(engine.accepts('Application/X-MPEGURL; charset=utf-8')).toBe(true);
  expect(engine.accepts('audio/mpegurl')).toBe(true);
  expect(engine.accepts('application/dash+xml')).toBe(false);
  expect(engine.accepts('audio/mpeg')).toBe(false);
  expect([...engine.capabilities()]).toContain('audio/mpegurl');
});
