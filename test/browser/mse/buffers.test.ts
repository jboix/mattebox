import { describe, expect, it } from 'vitest';
import type { Effect } from '../../../src/index.js';
import { createMseSink, sbIdFor } from '../../../src/kernel/sinks/mse-sink.js';
import {
  attachAndOpen,
  createBufferAndWait,
  createStack,
  fixture,
  pickVideoProfile,
  waitFor,
} from './helpers.js';

const profile = pickVideoProfile();

describe.runIf(profile !== null)('source buffers', () => {
  if (profile === null) return;
  it('addSourceBuffer succeeds for a probed codec string', async () => {
    const stack = createStack();
    await attachAndOpen(stack);
    await createBufferAndWait(stack, 'sb:video', profile.type);
    expect(stack.facts('SOURCEBUFFER_CREATED')).toHaveLength(1);
    expect(stack.bus.getState().buffers.has('sb:video')).toBe(true);
    stack.controller.detach();
  });

  it('a bogus codec fails cleanly with a MatteboxError, not a DOMException', async () => {
    const stack = createStack();
    await attachAndOpen(stack);
    await createBufferAndWait(stack, 'sb:video', 'video/mp4; codecs="bogus.99"');
    const errors = stack.facts('SOURCEBUFFER_ERROR');
    expect(errors).toHaveLength(1);
    const fact = errors[0];
    if (fact?.type !== 'SOURCEBUFFER_ERROR') throw new Error('expected a SOURCEBUFFER_ERROR');
    expect(fact.error.category).toBe('media');
    expect(fact.error.code).toBe('MEDIA_CODEC_UNSUPPORTED');
    expect(fact.error instanceof DOMException).toBe(false);
    stack.controller.detach();
  });

  it('a codec-less buffer waits for its first segment and opens with the probed type', async () => {
    const stack = createStack({ inferType: () => profile.type });
    await attachAndOpen(stack);
    stack.runner.run([{ kind: 'createSourceBuffer', sbId: 'sb:video', codecs: 'video/mp4' }]);
    // Deferred: nothing reported yet, and a repeat request is absorbed.
    stack.runner.run([{ kind: 'createSourceBuffer', sbId: 'sb:video', codecs: 'video/mp4' }]);
    expect(stack.facts('SOURCEBUFFER_CREATED')).toHaveLength(0);
    expect(stack.facts('SOURCEBUFFER_ERROR')).toHaveLength(0);

    const init = await fixture(profile.init);
    stack.runner.run([{ kind: 'append', sbId: 'sb:video', data: init, seq: -1 }]);
    await waitFor(() => stack.hasFact('SOURCEBUFFER_CREATED'), 'deferred buffer');
    const created = stack.facts('SOURCEBUFFER_CREATED')[0];
    expect(created).toMatchObject({ sbId: 'sb:video', codecs: profile.type });
    stack.controller.detach();
  });

  it('a codec-less buffer whose first segment the probe cannot read falls back to the bare type', async () => {
    const stack = createStack({ inferType: () => null });
    await attachAndOpen(stack);
    stack.runner.run([{ kind: 'createSourceBuffer', sbId: 'sb:video', codecs: 'video/mp4' }]);
    stack.runner.run([{ kind: 'append', sbId: 'sb:video', data: new ArrayBuffer(8), seq: 0 }]);
    // What the bare type does is the browser's call (Firefox opens it, Chrome
    // refuses); what matters is that the attempt is made and reported.
    await waitFor(
      () => stack.hasFact('SOURCEBUFFER_CREATED') || stack.hasFact('SOURCEBUFFER_ERROR'),
      'bare type attempt',
    );
    const fact = stack.facts('SOURCEBUFFER_CREATED')[0] ?? stack.facts('SOURCEBUFFER_ERROR')[0];
    expect(fact).toMatchObject({ sbId: 'sb:video' });
    if (fact?.type === 'SOURCEBUFFER_CREATED') expect(fact.codecs).toBe('video/mp4');
    stack.controller.detach();
  });

  it('serializes ten synchronous appends in order, never calling while updating', async () => {
    const stack = createStack();
    await attachAndOpen(stack);
    await createBufferAndWait(stack, 'sb:video', profile.type);

    // Instrument the real SourceBuffer, not a fake: record `updating` at
    // the moment the queue actually calls appendBuffer.
    const updatingAtCall: boolean[] = [];
    const appendedSizes: number[] = [];
    const original = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function patched(data: ArrayBuffer) {
      updatingAtCall.push(this.updating);
      appendedSizes.push(data.byteLength);
      return original.call(this, data);
    };

    try {
      const init = await fixture(profile.init);
      const seg = await fixture(profile.seg);
      const effects: Effect[] = [{ kind: 'append', sbId: 'sb:video', data: init }];
      for (let i = 0; i < 10; i += 1) {
        effects.push({ kind: 'setTimestampOffset', sbId: 'sb:video', offset: i * 2 });
        effects.push({ kind: 'append', sbId: 'sb:video', data: seg });
      }
      // All eleven appends land in one synchronous burst.
      stack.runner.run(effects);

      await waitFor(
        () => stack.facts('SOURCEBUFFER_UPDATEEND').length >= 11,
        'eleven updateends',
        20_000,
      );
      expect(updatingAtCall).toHaveLength(11);
      expect(updatingAtCall.every((updating) => updating === false)).toBe(true);
      expect(appendedSizes[0]).toBe(init.byteLength);
      expect(appendedSizes.slice(1).every((size) => size === seg.byteLength)).toBe(true);

      const buffered = stack.controller.buffered('sb:video');
      expect(buffered.length).toBeGreaterThan(0);
      const end = buffered[buffered.length - 1]?.end ?? 0;
      expect(end).toBeGreaterThan(18);
    } finally {
      SourceBuffer.prototype.appendBuffer = original;
      stack.controller.detach();
    }
  }, 30_000);

  it('a remove on an empty buffer is a no-op, not a fatal error', async () => {
    // remove() throws while the MediaSource duration is NaN, which it is
    // until the first append or the owner's deferred duration assignment.
    // The flush that clears a track's buffer can arrive before either, when
    // another buffer is still appending.
    const stack = createStack();
    await attachAndOpen(stack);
    await createBufferAndWait(stack, 'sb:video', profile.type);
    try {
      stack.runner.run([
        { kind: 'remove', sbId: 'sb:video', start: 0, end: Number.POSITIVE_INFINITY },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stack.facts('SOURCEBUFFER_ERROR')).toHaveLength(0);
      expect(stack.controller.buffered('sb:video')).toEqual([]);
    } finally {
      stack.controller.detach();
    }
  });

  it('a remove emitted after an append runs after it, even through an async transform', async () => {
    // cmaf-timing and the transmux put appends behind an async hop; a
    // remove taking a shortcut would run first and cut nothing.
    const stack = createStack({
      appendTransform: async (data) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return data;
      },
    });
    await attachAndOpen(stack);
    await createBufferAndWait(stack, 'sb:video', profile.type);
    try {
      const init = await fixture(profile.init);
      const seg = await fixture(profile.seg);
      stack.runner.run([
        { kind: 'append', sbId: 'sb:video', data: init },
        { kind: 'append', sbId: 'sb:video', data: seg },
        { kind: 'remove', sbId: 'sb:video', start: 0, end: Number.POSITIVE_INFINITY },
      ]);
      await waitFor(
        () => stack.facts('SOURCEBUFFER_UPDATEEND').length >= 3,
        'two appends and the remove',
        20_000,
      );
      expect(stack.controller.buffered('sb:video')).toEqual([]);
    } finally {
      stack.controller.detach();
    }
  }, 30_000);

  it('changeType between codec strings accepts the subsequent init segment', async () => {
    if (
      !('changeType' in SourceBuffer.prototype) ||
      !MediaSource.isTypeSupported(profile.altType)
    ) {
      return;
    }
    const stack = createStack();
    await attachAndOpen(stack);
    await createBufferAndWait(stack, 'sb:video', profile.type);

    const initBase = await fixture(profile.init);
    const segBase = await fixture(profile.seg);
    const initMain = await fixture(profile.altInit);
    const segMain = await fixture(profile.altSeg);

    stack.runner.run([
      { kind: 'append', sbId: 'sb:video', data: initBase },
      { kind: 'append', sbId: 'sb:video', data: segBase },
      { kind: 'changeType', sbId: 'sb:video', codecs: profile.altType },
      { kind: 'setTimestampOffset', sbId: 'sb:video', offset: 2 },
      { kind: 'append', sbId: 'sb:video', data: initMain },
      { kind: 'append', sbId: 'sb:video', data: segMain },
    ]);

    await waitFor(
      () => stack.facts('SOURCEBUFFER_UPDATEEND').length >= 4,
      'appends across changeType',
      20_000,
    );
    expect(stack.facts('SOURCEBUFFER_ERROR')).toHaveLength(0);
    const buffered = stack.controller.buffered('sb:video');
    const end = buffered[buffered.length - 1]?.end ?? 0;
    expect(end).toBeGreaterThan(3);
    stack.controller.detach();
  }, 30_000);

  it('MseSink emits append and remove effects against real ranges', async () => {
    const stack = createStack();
    await attachAndOpen(stack);
    await createBufferAndWait(stack, 'sb:video', profile.type);

    const sink = createMseSink('video', {
      buffered: (sbId) => stack.controller.buffered(sbId),
    });
    expect(sbIdFor('video')).toBe('sb:video');

    const init = await fixture(profile.init);
    const seg = await fixture(profile.seg);
    const meta = {
      trackId: 'v',
      renditionId: 'v-1',
      contentType: 'video' as const,
      seq: 0,
      start: 0,
      duration: 2,
      isInit: false,
    };
    stack.runner.run([
      ...sink.accept('v', init, { ...meta, isInit: true }),
      ...sink.accept('v', seg, meta),
    ]);
    // `buffered` is readable while an append is still being processed, so
    // wait for the whole segment to land, not for the first range to show.
    await waitFor(() => (sink.ranges('v')[0]?.end ?? 0) > 1, 'sink reports real ranges', 20_000);

    stack.runner.run(sink.clear('v', 0, 0.5));
    // The clear goes through the evictor clamp; with currentTime 0 it must
    // be dropped entirely, never removing at the playhead.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sink.ranges('v')[0]?.start ?? 1).toBeLessThan(0.5);
    stack.controller.detach();
  }, 30_000);
});
