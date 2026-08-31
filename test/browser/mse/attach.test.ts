import { describe, expect, it } from 'vitest';
import {
  attachAndOpen,
  createBufferAndWait,
  createStack,
  pickVideoProfile,
  waitFor,
} from './helpers.js';

describe('attach', () => {
  it('attaches and sourceopen fires', async () => {
    const stack = createStack();
    stack.controller.attach(stack.el);
    await waitFor(() => stack.hasFact('MEDIASOURCE_OPEN'), 'MEDIASOURCE_OPEN fact');
    expect(stack.controller.readyState()).toBe('open');
    expect(stack.hasFact('ELEMENT_ATTACHED')).toBe(true);
    // Whichever path was taken, no object URL may stay live after open.
    expect(stack.controller.diagnostics().liveObjectUrls).toBe(0);
    const viaSrcObject = stack.el.srcObject !== null;
    const viaBlobUrl = stack.el.currentSrc.startsWith('blob:') || stack.el.src.startsWith('blob:');
    expect(viaSrcObject || viaBlobUrl).toBe(true);
    stack.controller.detach();
  });

  it('blob-URL fallback revokes the URL at sourceopen, not detach', async () => {
    const stack = createStack({ attachMode: 'object-url' });
    stack.controller.attach(stack.el);
    // Before sourceopen the URL must be live; the attach is synchronous.
    expect(stack.controller.diagnostics().liveObjectUrls).toBe(1);
    expect(stack.el.src.startsWith('blob:')).toBe(true);

    await waitFor(() => stack.hasFact('MEDIASOURCE_OPEN'), 'sourceopen');
    expect(stack.controller.diagnostics().liveObjectUrls).toBe(0);
    stack.controller.detach();
  });

  it('refuses an element that already has a source', () => {
    const stack = createStack();
    stack.el.src = 'https://cdn.example/existing.mp4';
    expect(() => stack.controller.attach(stack.el)).toThrowError(/already has a source/);
  });

  it('three attach-detach cycles leak no object URLs and no listeners', async () => {
    const stack = createStack({ attachMode: 'object-url' });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      stack.controller.attach(stack.el);
      await waitFor(() => stack.controller.readyState() === 'open', `open, cycle ${cycle}`);
      const profile = pickVideoProfile();
      if (profile !== null) {
        await createBufferAndWait(stack, 'sb:video', profile.type);
      }
      stack.controller.detach();
      const diag = stack.controller.diagnostics();
      expect(diag.liveObjectUrls).toBe(0);
      expect(diag.liveListeners).toBe(0);
      expect(diag.sourceBuffers).toBe(0);
      expect(stack.controller.readyState()).toBe('detached');
    }
  });

  it('detach is idempotent, also from an error state', async () => {
    const stack = createStack();
    await attachAndOpen(stack);
    // Drive it into an error: a bogus codec produces an error fact.
    await createBufferAndWait(stack, 'sb:video', 'video/mp4; codecs="bogus.42"');
    expect(stack.hasFact('SOURCEBUFFER_ERROR')).toBe(true);

    stack.controller.detach();
    stack.controller.detach();
    expect(stack.controller.diagnostics().liveListeners).toBe(0);

    // Detach without any attach is also a no-op.
    const fresh = createStack();
    fresh.controller.detach();
    expect(fresh.controller.readyState()).toBe('detached');
  });

  it('a stale SOURCEBUFFER_UPDATEEND after detach is absorbed without error', async () => {
    const stack = createStack();
    await attachAndOpen(stack);
    const profile = pickVideoProfile();
    if (profile === null) return;
    await createBufferAndWait(stack, 'sb:video', profile.type);
    stack.controller.detach();

    const before = stack.bus.getState();
    expect(() =>
      stack.bus.absorb({ type: 'SOURCEBUFFER_UPDATEEND', sbId: 'sb:video' }),
    ).not.toThrow();
    expect(stack.bus.getState()).toEqual(before);
    expect(stack.facts('SOURCEBUFFER_ERROR')).toHaveLength(0);
  });
});

describe('ManagedMediaSource', () => {
  const hasMms = 'ManagedMediaSource' in globalThis;

  it.runIf(hasMms)('is preferred where available and opens', async () => {
    const stack = createStack();
    await attachAndOpen(stack);
    expect(stack.controller.isManaged()).toBe(true);
    expect(stack.el.disableRemotePlayback).toBe(true);
    stack.controller.detach();
  });

  it.runIf(!hasMms)('falls back to plain MediaSource where absent', async () => {
    const stack = createStack();
    await attachAndOpen(stack);
    expect(stack.controller.isManaged()).toBe(false);
    stack.controller.detach();
  });
});
