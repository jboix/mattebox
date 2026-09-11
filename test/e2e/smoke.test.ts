import { expect, it } from 'vitest';
import { mattebox } from '../../src/index.js';
import { flavor } from './harness.js';

// Tier 4 wiring proof: the fixture server answers on the tester's origin
// with streaming MIME types, and the engine under test is the shipped build.
it('serves the corpus from the tester origin with streaming MIME types', async () => {
  const res = await fetch(`/streams/${flavor}/master.m3u8`);
  expect(res.ok).toBe(true);
  expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
});

it('drives a real media element', async () => {
  const el = document.createElement('video');
  el.muted = true;
  const engine = mattebox({ stages: [] });
  await engine.attach(el);
  expect(el.readyState).toBe(0);
  expect(mattebox.from(el)).toBe(engine);
  await engine.detach();
});
