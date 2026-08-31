import { expect, it } from 'vitest';
import { MATTEBOX } from '../../src/index.js';

// Tier 1/2 wiring proof — real kernel tests arrive with the kernel (Stage 02).
it('runs in a plain node environment with no DOM', () => {
  expect(MATTEBOX).toBe('mattebox');
  expect(typeof globalThis.document).toBe('undefined');
});
