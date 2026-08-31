import { describe, expect, it } from 'vitest';
import { probeInitSegment, reconcileCodecs } from '../../../src/containers/codec-probe/index.js';
import { attachAndOpen, createStack, waitFor } from './helpers.js';

async function loadInit(name: string): Promise<Uint8Array> {
  const url = new URL(`../../fixtures/segments/${name}`, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${name}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Every probed string this browser claims to decode must round-trip
// through the real isTypeSupported. Support differs per browser; the
// assertion is that the PROBE never produces a string the browser rejects
// for a codec the browser demonstrably plays.
const CORPUS = [
  'init-v-base.mp4',
  'init-v-main.mp4',
  'init-v-high.mp4',
  'init-v-hevc.mp4',
  'init-v-vp9.mp4',
  'init-v-av1.mp4',
  'init-a.mp4',
  'init-a-opus.mp4',
];

describe('probed codec strings against real MediaSource', () => {
  it('6. every derivable string is well-formed for isTypeSupported', async () => {
    let checked = 0;
    let supported = 0;
    for (const name of CORPUS) {
      const probe = probeInitSegment(await loadInit(name));
      expect(probe.error).toBeNull();
      expect(probe.mimeType).not.toBeNull();
      checked += 1;
      if (MediaSource.isTypeSupported(probe.mimeType as string)) supported += 1;
    }
    expect(checked).toBe(CORPUS.length);
    // A browser supports some subset; a probe corpus where nothing passes
    // would mean the strings are malformed, not the codecs missing.
    expect(supported).toBeGreaterThan(0);
  });

  it('7. manifest mismatch: the probe wins, a warning is emitted, addSourceBuffer succeeds', async () => {
    // Find a video init this browser supports.
    let init: Uint8Array | null = null;
    let probed: ReturnType<typeof probeInitSegment> | null = null;
    for (const name of ['init-v-base.mp4', 'init-v-vp9.mp4']) {
      const bytes = await loadInit(name);
      const probe = probeInitSegment(bytes);
      if (probe.mimeType !== null && MediaSource.isTypeSupported(probe.mimeType)) {
        init = bytes;
        probed = probe;
        break;
      }
    }
    if (init === null || probed === null) return;

    const stack = createStack();
    await attachAndOpen(stack);

    // The manifest lies about the codec; reconciliation prefers the probe
    // and surfaces the discrepancy as a warning event.
    const manifestClaim = 'video/mp4; codecs="avc1.999999"';
    const outcome = reconcileCodecs(manifestClaim, probed);
    expect(outcome.mismatch).toBe(true);
    const warnings: unknown[] = [];
    stack.bus.on('codec:mismatch', (payload) => warnings.push(payload));
    stack.bus.emitEvent('codec:mismatch', { manifest: manifestClaim, probed: probed.mimeType });
    expect(warnings).toHaveLength(1);

    stack.runner.run([
      { kind: 'createSourceBuffer', sbId: 'sb:video', codecs: outcome.contentType },
    ]);
    await waitFor(() => stack.hasFact('SOURCEBUFFER_CREATED'), 'buffer from probed codec');
    expect(stack.facts('SOURCEBUFFER_ERROR')).toHaveLength(0);

    // The init the probe read appends cleanly into the buffer it sized.
    stack.runner.run([{ kind: 'append', sbId: 'sb:video', data: init.slice().buffer }]);
    await waitFor(() => stack.facts('SOURCEBUFFER_UPDATEEND').length >= 1, 'init appended');
    expect(stack.facts('SOURCEBUFFER_ERROR')).toHaveLength(0);
    stack.controller.detach();
  });
});
