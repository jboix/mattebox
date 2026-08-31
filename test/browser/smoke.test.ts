import { expect, it } from 'vitest';
import { mattebox } from '../../src/index.js';

// Tier 3 wiring proof, running in real Chromium, Firefox, and WebKit.
it('attaches to a real element and is discoverable from it', async () => {
  const el = document.createElement('video');
  el.muted = true;
  const engine = mattebox({ stages: [] });
  await engine.attach(el);
  expect(engine.media).toBe(el);
  expect(mattebox.from(el)).toBe(engine);
  await engine.detach();
  expect(mattebox.from(el)).toBeNull();
});
