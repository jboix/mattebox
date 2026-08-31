import { expect, it } from 'vitest';
import { MATTEBOX } from '../../src/index.js';

// Tier 3 wiring proof — runs in real Chromium, Firefox, and WebKit.
// Real MSE integration tests arrive with the mse adapter (Stage 03).
it('runs in a real browser', () => {
  expect(MATTEBOX).toBe('mattebox');
  expect(typeof window).toBe('object');
  expect(typeof document.createElement('video').canPlayType).toBe('function');
});
