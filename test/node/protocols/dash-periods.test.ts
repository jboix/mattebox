// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '../../../src/protocols/dash-cmaf/parse.js';
import { installPeriods } from '../../../src/protocols/dash-cmaf/periods-runtime.js';
import type { Presentation } from '../../../src/types/ir.js';
import type { Command } from '../../../src/types/messages.js';
import type { SegmentMeta } from '../../../src/types/sink.js';
import type { StageContext, TransformStep } from '../../../src/types/stage.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/manifests');
const mpd = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

function harness(presentation: Presentation, skips: Array<{ start: number; end: number }> = []) {
  const element = Object.assign(new EventTarget(), { currentTime: 0, seeking: false });
  const requested: string[] = [];
  const dispatched: Command[] = [];
  let step: TransformStep | null = null;
  installPeriods(
    {
      element,
      getState: () => ({ presentation }),
      registerTransform: (s: TransformStep) => {
        step = s;
      },
      request: (url: string) => {
        requested.push(url);
        return Promise.resolve(new Response(new TextEncoder().encode(`[${url.split('/mp/')[1]}]`)));
      },
      dispatch: (cmd: Command) => dispatched.push(cmd),
    } as unknown as StageContext,
    () => skips,
  );
  const run = async (
    renditionId: string,
    seq: number,
    body: string,
    contentType: SegmentMeta['contentType'] = 'video',
  ) => {
    const meta: SegmentMeta = {
      trackId: 't',
      renditionId,
      contentType,
      seq,
      start: 0,
      duration: 4,
      isInit: seq < 0,
    };
    const out = await (step as unknown as TransformStep).transform(
      new TextEncoder().encode(body),
      meta,
    );
    return new TextDecoder().decode(out);
  };
  return { element, requested, dispatched, run };
}

describe('a flattened multi-period presentation at playback', () => {
  const flat = () =>
    parse(mpd('edge-multiperiod.mpd'), 'https://cdn.example/m.mpd').presentation as Presentation;

  it("puts a period's init in front of its segments, only when the buffer holds another", async () => {
    const h = harness(flat());
    expect(await h.run('v-lo', -1, 'init')).toBe('init');
    expect(await h.run('v-lo', 0, 's0')).toBe('s0');
    expect(await h.run('v-lo', 3, 'ad1')).toBe('[ad/ad-v1/init.mp4]ad1');
    expect(await h.run('v-lo', 4, 'ad2')).toBe('ad2');
    // Back to the content: its own init again.
    expect(await h.run('v-lo', 5, 'c4')).toBe('[c1/v-lo/init.mp4]c4');
    expect(await h.run('v-lo', 6, 'c5')).toBe('c5');
    // After a seek the buffer's init is unknown: the next segment brings its own.
    h.element.dispatchEvent(new Event('seeking'));
    expect(await h.run('v-lo', 7, 'c6')).toBe('[c1/v-lo/init.mp4]c6');
    expect(h.requested).toEqual([
      'https://cdn.example/mp/ad/ad-v1/init.mp4',
      'https://cdn.example/mp/c1/v-lo/init.mp4',
    ]);
  });

  it("dates a later period's WebVTT from its start with an X-TIMESTAMP-MAP header", async () => {
    const h = harness(flat());
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n';
    expect(await h.run('t-en', 0, vtt, 'text')).toBe(vtt);
    expect(await h.run('t-en', 1, vtt, 'text')).toBe(
      'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:1620000\n\n00:00:01.000 --> 00:00:02.000\nhi\n',
    );
  });

  it('seeks past a left-out period when playback reaches it', () => {
    const h = harness(flat(), [{ start: 12, end: 18 }]);
    h.element.currentTime = 10;
    h.element.dispatchEvent(new Event('timeupdate'));
    h.element.currentTime = 11.8;
    h.element.dispatchEvent(new Event('waiting'));
    expect(h.dispatched).toEqual([{ type: 'SEEK', to: 18.05 }]);
  });

  it('leaves single-period content alone', async () => {
    const single = parse(mpd('edge-segmentlist.mpd'), 'https://cdn.example/m.mpd')
      .presentation as Presentation;
    const h = harness(single);
    expect(await h.run('v1', -1, 'init')).toBe('init');
    expect(await h.run('v1', 0, 's0')).toBe('s0');
    expect(h.requested).toEqual([]);
  });
});
