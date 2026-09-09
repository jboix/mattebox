import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { walkBoxes } from '../../../src/containers/mp4-box/index.js';
import tsTransmux from '../../../src/containers/ts-transmux/index.js';
import type { KernelState } from '../../../src/types/kernel.js';
import type { SegmentMeta } from '../../../src/types/sink.js';
import type { StageContext, TransformStep } from '../../../src/types/stage.js';

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../fixtures/golden/${name}`, import.meta.url))),
  );
}

/** A StageContext that records only what this stage touches. */
function captureContext(activeAudio: string | null = null): {
  ctx: StageContext;
  transforms: TransformStep[];
  events: Array<{ event: string; payload: unknown }>;
} {
  const transforms: TransformStep[] = [];
  const events: Array<{ event: string; payload: unknown }> = [];
  const active = new Map<string, string>();
  if (activeAudio !== null) active.set('audio', activeAudio);
  const ctx = {
    registerTransform: (step: TransformStep) => transforms.push(step),
    getState: () => ({ tracks: { active, available: [] } }) as unknown as KernelState,
    emit: (event: string, payload: unknown) => events.push({ event, payload }),
  } as unknown as StageContext;
  return { ctx, transforms, events };
}

function trakCount(data: Uint8Array): number {
  let count = 0;
  walkBoxes(data, (box) => {
    if (box.type === 'trak') count += 1;
    return true;
  });
  return count;
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

  it('keeps muxed audio on the video buffer when no audio track is active', async () => {
    const { ctx, transforms, events } = captureContext();
    tsTransmux({ disableWorker: true }).install(ctx);
    const step = transforms[0] as TransformStep;
    const out = await step.transform(fixture('muxed.m2ts'), videoMeta);
    expect(trakCount(out)).toBe(2);
    expect(events).toHaveLength(0);
  });

  it('drops muxed audio from video segments once a separate audio track is active', async () => {
    // The SRF layout: every variant muxes AAC, and the master also names an
    // audio group with its own playlist. The audio rendition owns sb:audio,
    // so the video buffer, typed with the video codec alone, must not see
    // the muxed track (Chrome refuses the append) nor play the audio twice.
    const { ctx, transforms, events } = captureContext('audio0:Deutsch');
    tsTransmux({ disableWorker: true }).install(ctx);
    const step = transforms[0] as TransformStep;
    const first = await step.transform(fixture('muxed.m2ts'), videoMeta);
    expect(trakCount(first)).toBe(1);
    // Announced once per composition, not once per segment.
    await step.transform(fixture('muxed.m2ts'), { ...videoMeta, seq: 1, start: 6 });
    expect(events).toEqual([
      { event: 'transmux:dropped-audio', payload: { trackId: 'sb:video', renditionId: 'v' } },
    ]);
  });

  it('keeps only the audio stream for an audio segment', async () => {
    const { ctx, transforms, events } = captureContext('audio0:Deutsch');
    tsTransmux({ disableWorker: true }).install(ctx);
    const step = transforms[0] as TransformStep;
    const audioMeta: SegmentMeta = { ...videoMeta, trackId: 'sb:audio', contentType: 'audio' };
    const out = await step.transform(fixture('muxed.m2ts'), audioMeta);
    expect(trakCount(out)).toBe(1);
    expect(events).toHaveLength(0);
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
