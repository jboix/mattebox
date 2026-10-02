import { describe, expect, it } from 'vitest';
import hdr, { type HdrApi } from '../../../src/stages/hdr/index.js';
import type { Presentation, Rendition } from '../../../src/types/ir.js';
import type { Command } from '../../../src/types/messages.js';
import type { StageContext } from '../../../src/types/stage.js';

/**
 * The hdr stage on the real probes. Current Chromium, Firefox, and WebKit
 * all know the `dynamic-range` media feature, so the answer comes from the
 * probes; the TV floor (Chromium 76 and 79) knows neither, which the node
 * tests cover with stubs.
 */

const rung = (id: string, videoRange: NonNullable<Rendition['videoRange']>): Rendition => ({
  id,
  bitrate: 5_000_000,
  codecs: 'hvc1.2.4.L150.B0',
  mimeType: 'video/mp4',
  segments: [],
  width: 3840,
  height: 2160,
  videoRange,
});

describe('the hdr stage in a browser', () => {
  it('reads the display from the dynamic-range media feature and constrains to match', async () => {
    const presentation: Presentation = {
      id: 'p',
      isLive: false,
      couplings: [],
      periods: [
        {
          id: 'p0',
          start: 0,
          tracks: [
            {
              id: 'v',
              contentType: 'video',
              mimeType: 'video/mp4',
              protection: null,
              renditions: [rung('sdr', 'SDR'), rung('pq', 'PQ')],
            },
          ],
        },
      ],
    };
    const dispatched: Command[] = [];
    let api: HdrApi | null = null;
    let changed: (() => void) | null = null;
    const teardown = hdr().install({
      getState: () => ({ presentation }),
      dispatch: (cmd: Command) => dispatched.push(cmd),
      on: (_: string, fn: () => void) => {
        changed = fn;
        return () => undefined;
      },
      registerNamespace: (_: string, value: HdrApi) => {
        api = value;
      },
    } as unknown as StageContext);
    (changed as unknown as () => void)();
    const view = api as unknown as HdrApi;
    await expect.poll(() => view.source, { timeout: 5_000 }).not.toBeNull();
    expect(view.source).toBe('probe');
    const display = matchMedia('(dynamic-range: high)').matches;
    expect(view.display).toBe(display);
    if (!display) {
      expect(dispatched).toContainEqual({
        type: 'CONSTRAIN',
        source: 'hdr',
        constraint: { hdr: false },
      });
    }
    if (typeof teardown === 'function') teardown();
  });
});
