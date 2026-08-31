import { describe, expect, it } from 'vitest';
import { createReducer, initialState } from '../../../src/kernel/reducer.js';
import { parseTimestamp, parseVtt } from '../../../src/stages/text-webvtt/parse.js';
import { shiftTimestampMap } from '../../../src/stages/text-webvtt-segmented/index.js';
import type { Presentation } from '../../../src/types/ir.js';
import type { KernelState } from '../../../src/types/kernel.js';

const SAMPLE = `WEBVTT

00:00:01.000 --> 00:00:04.000 line:90% align:center
Hello <v Anna>there</v>

id-42
00:00:05.000 --> 00:00:08.000
Second cue
across two lines

NOTE a comment block

bogus timing line
not-a-timestamp --> 00:00:09.000
Broken

00:00:10.000 --> 00:00:09.000
Ends before it starts
`;

describe('the WebVTT parser', () => {
  it('parses timings, settings, ids, and multi-line payloads', () => {
    const { cues, skipped } = parseVtt(SAMPLE);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({
      start: 1,
      end: 4,
      text: 'Hello <v Anna>there</v>',
      settings: 'line:90% align:center',
    });
    expect(cues[1]).toMatchObject({ id: 'id-42', start: 5, end: 8 });
    expect(cues[1]?.text).toBe('Second cue\nacross two lines');
    expect(skipped).toBe(2);
  });

  it('a BOM does not defeat the signature check', () => {
    const { cues } = parseVtt(`﻿WEBVTT\n\n00:00.500 --> 00:03.500\nshort form`);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.start).toBe(0.5);
  });

  it('non-VTT content yields no cues and no throw', () => {
    expect(parseVtt('#EXTM3U not a vtt').cues).toEqual([]);
  });

  it('generated ids are deterministic, so re-parsing dedups at the sink', () => {
    const first = parseVtt(SAMPLE).cues[0]?.id;
    const second = parseVtt(SAMPLE).cues[0]?.id;
    expect(first).toBeDefined();
    expect(first).toBe(second);
  });

  it('parses both timestamp forms', () => {
    expect(parseTimestamp('01:02:03.250')).toBe(3723.25);
    expect(parseTimestamp('02:03.250')).toBe(123.25);
    expect(parseTimestamp('junk')).toBeNull();
  });
});

describe('X-TIMESTAMP-MAP shifting', () => {
  it('LOCAL 0 with MPEGTS 900000 lands the cue at presentation 10 s', () => {
    const shifted = shiftTimestampMap(
      `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n\n00:00:00.000 --> 00:00:02.000\nten`,
    );
    const { cues } = parseVtt(shifted);
    expect(cues[0]?.start).toBe(10);
    expect(cues[0]?.end).toBe(12);
    expect(shifted).not.toContain('X-TIMESTAMP-MAP');
  });

  it('a non-zero LOCAL subtracts before the MPEGTS offset adds', () => {
    const shifted = shiftTimestampMap(
      `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:02.000,MPEGTS:1080000\n\n00:00:02.500 --> 00:00:03.000\ncue`,
    );
    const { cues } = parseVtt(shifted);
    // offset = 12 - 2 = 10; cue at 2.5 lands at 12.5.
    expect(cues[0]?.start).toBe(12.5);
  });

  it('a segment without the header passes through untouched', () => {
    const plain = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nplain`;
    expect(shiftTimestampMap(plain)).toBe(plain);
  });
});

// ---- the kernel side: scheduling, delivery, deselection ------------------

function textPresentation(): Presentation {
  return {
    id: 'p',
    isLive: false,
    duration: 12,
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
            renditions: [
              {
                id: 'v-1',
                bitrate: 500_000,
                codecs: 'avc1.42c01e',
                mimeType: 'video/mp4',
                segments: [{ seq: 0, start: 0, duration: 12, url: 'https://cdn.example/v/0.m4s' }],
              },
            ],
          },
          {
            id: 'subs:English',
            contentType: 'text',
            mimeType: 'text/vtt',
            lang: 'en',
            protection: null,
            renditions: [
              {
                id: 'subs:English',
                bitrate: 0,
                codecs: null,
                mimeType: 'text/vtt',
                segments: [
                  { seq: 0, start: 0, duration: 4, url: 'https://cdn.example/s/0.vtt' },
                  { seq: 1, start: 4, duration: 4, url: 'https://cdn.example/s/1.vtt' },
                  { seq: 2, start: 8, duration: 4, url: 'https://cdn.example/s/2.vtt' },
                ],
              },
            ],
          },
        ],
      },
    ],
    couplings: [],
  };
}

function textReadyState(): KernelState {
  const base = initialState();
  return {
    ...base,
    lifecycle: { phase: 'ready' },
    presentation: textPresentation(),
    buffers: new Map([
      [
        'sb:video',
        { codecs: 'avc1', ranges: [{ start: 0, end: 12 }], pendingAppends: 0, initFor: 'v-1' },
      ],
    ]),
    tracks: {
      active: new Map([
        ['video', 'v'],
        ['text', 'subs:English'],
      ]),
      available: ['v', 'subs:English'],
    },
  };
}

describe('the kernel schedules and delivers cue tracks', () => {
  const reduce = createReducer();

  it('a selected text track fetches like media, without a SourceBuffer', () => {
    const [next, fx] = reduce(textReadyState(), {
      type: 'TIME_UPDATE',
      currentTime: 0,
      buffered: [],
    });
    const fetch = fx.find((e) => e.kind === 'fetch');
    expect(fetch).toMatchObject({ url: 'https://cdn.example/s/0.vtt' });
    const request = [...next.scheduling.inflight.values()].find(
      (r) => r.trackId === 'subs:English',
    );
    expect(request?.sbId).toBeUndefined();
  });

  it('loaded text bytes become a deliver effect and coverage, then the next segment fetches', () => {
    const [state] = reduce(textReadyState(), { type: 'TIME_UPDATE', currentTime: 0, buffered: [] });
    const bytes = new TextEncoder().encode('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi')
      .buffer as ArrayBuffer;
    const [next, fx] = reduce(state, {
      type: 'SEGMENT_LOADED',
      trackId: 'subs:English',
      seq: 0,
      bytes,
      rtt: 5,
      size: bytes.byteLength,
    });
    const deliver = fx.find((e) => e.kind === 'deliver');
    expect(deliver).toMatchObject({ trackId: 'subs:English', contentType: 'text' });
    expect(next.cues.get('subs:English')).toEqual([{ start: 0, end: 4 }]);
    expect(fx.find((e) => e.kind === 'fetch')).toMatchObject({
      url: 'https://cdn.example/s/1.vtt',
    });
  });

  it('a failed text segment degrades: non-fatal, covered, playback untouched', () => {
    const [state] = reduce(textReadyState(), { type: 'TIME_UPDATE', currentTime: 0, buffered: [] });
    const [next, fx] = reduce(state, {
      type: 'SEGMENT_FAILED',
      trackId: 'subs:English',
      seq: 0,
      status: 404,
      error: {
        category: 'network',
        code: 'NETWORK_HTTP_STATUS',
        fatal: true,
        recoverable: false,
      },
    });
    expect(fx[0]).toMatchObject({ kind: 'emit', event: 'error', payload: { fatal: false } });
    expect(next.lifecycle.phase).toBe('ready');
    expect(next.cues.get('subs:English')).toEqual([{ start: 0, end: 4 }]);
  });

  it('deselecting clears coverage, aborts, and emits clearCues; video and audio refuse', () => {
    const [state] = reduce(textReadyState(), { type: 'TIME_UPDATE', currentTime: 0, buffered: [] });
    const [next, fx] = reduce(state, { type: 'DESELECT_TRACK', contentType: 'text' });
    expect(next.tracks.active.has('text')).toBe(false);
    expect(next.cues.has('subs:English')).toBe(false);
    expect(fx.map((e) => e.kind)).toEqual(['abort', 'clearCues', 'emit']);
    expect(fx[2]).toMatchObject({
      event: 'tracks:selected',
      payload: { contentType: 'text', trackId: null },
    });

    const [, rejected] = reduce(next, { type: 'DESELECT_TRACK', contentType: 'video' });
    expect(rejected[0]).toMatchObject({ kind: 'emit', event: 'command:rejected' });
  });

  it('UNLOAD clears every cue track, so the next source does not start under the last subtitle', () => {
    const state: KernelState = {
      ...textReadyState(),
      cues: new Map([['subs:English', [{ start: 0, end: 8 }]]]),
    };
    const [next, fx] = reduce(state, { type: 'UNLOAD' });
    expect(next.cues.size).toBe(0);
    expect(fx).toContainEqual({
      kind: 'clearCues',
      trackId: 'subs:English',
      start: 0,
      end: Number.POSITIVE_INFINITY,
    });
  });

  it('a short subtitle playlist does not hold endOfStream open', () => {
    const state = textReadyState();
    const covered: KernelState = {
      ...state,
      cues: new Map([['subs:English', [{ start: 0, end: 8 }]]]),
      scheduling: {
        ...state.scheduling,
        inflight: new Map([
          [
            't9:subs:English:2',
            {
              token: 't9:subs:English:2',
              trackId: 'subs:English',
              seq: 2,
              url: 'https://cdn.example/s/2.vtt',
              segmentStart: 8,
              segmentDuration: 4,
            },
          ],
        ]),
      },
    };
    // Video is fully buffered to the duration; the text track still has an
    // uncovered tail but must not block the end.
    const [, fx] = reduce(covered, { type: 'TIME_UPDATE', currentTime: 11, buffered: [] });
    expect(fx.find((e) => e.kind === 'endOfStream')).toBeDefined();
  });
});
