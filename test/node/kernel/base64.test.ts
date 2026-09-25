import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '../../../src/kernel/base64.js';

describe('base64', () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0x3e, 0x01]);

  it('round-trips standard base64 and ignores whitespace', () => {
    expect(bytesToBase64(bytes)).toBe('+/8+AQ==');
    expect(base64ToBytes(' +/8+\nAQ== ')).toEqual(bytes);
  });

  it('writes unpadded base64url', () => {
    expect(bytesToBase64(bytes, true)).toBe('-_8-AQ');
  });

  it('answers null for text that is not base64', () => {
    expect(base64ToBytes('not base64!')).toBeNull();
  });
});
