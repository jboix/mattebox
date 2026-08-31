import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import tsTransmux from '../../../src/containers/ts-transmux/index.js';
import type { SegmentMeta } from '../../../src/types/sink.js';
import type { StageContext, TransformStep } from '../../../src/types/stage.js';

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../fixtures/golden/${name}`, import.meta.url))),
  );
}

/** A StageContext that records only what this stage touches. */
function captureContext(): { ctx: StageContext; transforms: TransformStep[] } {
  const transforms: TransformStep[] = [];
  const ctx = {
    registerTransform: (step: TransformStep) => transforms.push(step),
  } as unknown as StageContext;
  return { ctx, transforms };
}

const videoMeta: SegmentMeta = {
  trackId: 'sb:video',
  renditionId: 'v',
  contentType: 'video',
  seq: 0,
  start: 0,
  duration: 6,
  isInit: false,
};

describe('ts-transmux stage', () => {
  it('provides ts-transmux and media-transform, requiring no adapter', () => {
    const stage = tsTransmux();
    expect(stage.provides).toContain('ts-transmux');
    expect(stage.provides).toContain('media-transform');
    // It contributes only a transform; it requires nothing, so it composes
    // beside any protocol adapter without one importing it.
    expect(stage.requires ?? []).toHaveLength(0);
  });

  it('registers one transform at an order after decrypt', () => {
    const { ctx, transforms } = captureContext();
    tsTransmux().install(ctx);
    expect(transforms).toHaveLength(1);
    expect(transforms[0]?.name).toBe('ts-transmux');
    // Below caption extraction, above the decrypt class (which Stage 18 adds
    // at a lower order). The pipeline sorts ascending, so a lower-order
    // decrypt step runs first.
    expect(transforms[0]?.order).toBe(100);
    expect(transforms[0]?.order).toBeGreaterThan(10);
  });

  it('transmuxes a transport stream and passes fMP4 straight through', async () => {
    const { ctx, transforms } = captureContext();
    tsTransmux({ disableWorker: true }).install(ctx);
    const step = transforms[0] as TransformStep;

    // A TS segment comes back as fMP4 (ftyp is the first box).
    const ts = fixture('muxed.m2ts');
    const out = await step.transform(ts, videoMeta);
    expect(out).not.toBe(ts);
    expect(String.fromCharCode(out[4] ?? 0, out[5] ?? 0, out[6] ?? 0, out[7] ?? 0)).toBe('ftyp');

    // An fMP4 segment sniffs false and is returned unchanged, no copy.
    const fmp4 = fixture('muxed.fmp4');
    const passed = await step.transform(fmp4, videoMeta);
    expect(passed).toBe(fmp4);
  });

  it('leaves text and metadata bytes untouched', async () => {
    const { ctx, transforms } = captureContext();
    tsTransmux({ disableWorker: true }).install(ctx);
    const step = transforms[0] as TransformStep;
    const bytes = fixture('muxed.m2ts');
    const textMeta: SegmentMeta = { ...videoMeta, contentType: 'text' };
    expect(await step.transform(bytes, textMeta)).toBe(bytes);
  });

  it('a lower-order decrypt stub runs before transmux when both are registered', () => {
    // The pipeline the engine builds: sort by order, ascending.
    const decrypt: TransformStep = { name: 'sample-aes', order: 10, transform: (d) => d };
    const { ctx, transforms } = captureContext();
    tsTransmux().install(ctx);
    const pipeline = [transforms[0] as TransformStep, decrypt].sort((a, b) => a.order - b.order);
    expect(pipeline.map((s) => s.name)).toEqual(['sample-aes', 'ts-transmux']);
  });
});
