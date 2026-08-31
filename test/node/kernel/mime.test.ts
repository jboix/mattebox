import { describe, expect, it } from 'vitest';
import { isManifestType, normalizeMimeType } from '../../../src/kernel/mime.js';

describe('mime', () => {
  it('normalizes case, parameters, and whitespace', () => {
    expect(normalizeMimeType('Application/X-MPEGURL')).toBe('application/x-mpegurl');
    expect(normalizeMimeType('application/dash+xml; charset=utf-8')).toBe('application/dash+xml');
    expect(normalizeMimeType('  audio/mpegurl ;q=1')).toBe('audio/mpegurl');
    expect(normalizeMimeType('')).toBe('');
  });

  it('tells a manifest type from a stage name', () => {
    expect(isManifestType('application/vnd.apple.mpegurl')).toBe(true);
    expect(isManifestType('hls-cmaf')).toBe(false);
    expect(isManifestType('media-transform')).toBe(false);
  });
});
