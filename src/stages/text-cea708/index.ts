/**
 * CEA-708 in-band captions as a stage. It registers a caption consumer
 * beside text-cea608's, and reads the DTVCC triples (cc_type 2 and 3) that
 * stage leaves. Each service is a text track like any subtitle: HLS
 * `INSTREAM-ID="SERVICEn"`, DASH `urn:scte:dash:cc:cea-708:2015`, or a track
 * added on the service's first cue (`cea708:SERVICEn`).
 *
 * Each visible window becomes a VTTCue on the service's native caption
 * track, labelled SERVICEn. The window's anchor maps to `line` and
 * `position`, its anchor point to `lineAlign` and `positionAlign`, its
 * column count to `size`, its justification to `align`, and the pen's
 * italics and underline to `<i>` and `<u>`. Colors, opacities, edges, and
 * fonts are not mapped: a VTTCue carries no color without page CSS. The cue
 * keeps the window layout in a `cea708` property the browser ignores, for a
 * player that draws captions itself.
 */
import { registerCaptionConsumer } from '../../containers/captions.js';
import { inbandCaptions, vttCue } from '../../kernel/sinks/caption-tracks.js';
import type { Stage } from '../../types/stage.js';
import { type Cue708, Dtvcc } from './decode.js';

const MIME = 'application/cea-708';

/** The settings of a VTTCue this stage writes, typed loosely: Chromium 76 lacks some. */
interface PlacedCue {
  snapToLines: boolean;
  line: number | 'auto';
  position: number | 'auto';
  size: number;
  align: string;
  lineAlign: string;
  positionAlign: string;
  cea708: unknown;
}

const ALIGN = ['left', 'right', 'center', 'left'];
const LINE_ALIGN = ['start', 'center', 'end'];
const POSITION_ALIGN = ['line-left', 'center', 'line-right'];

/**
 * Places the cue where its window sits (§8.4). Relative anchors are percent;
 * absolute ones are cells of a 75-row grid, 210 columns wide at 16:9 and 160
 * at 4:3. A browser that rejects a value keeps its default for it.
 */
function place(target: TextTrackCue, cue: Cue708, wide: boolean): void {
  const placed = target as unknown as PlacedCue;
  const { layout } = cue;
  const across = wide ? 210 : 160;
  const line = layout.relative ? layout.anchorVertical : (layout.anchorVertical / 75) * 100;
  const position = layout.relative
    ? layout.anchorHorizontal
    : (layout.anchorHorizontal / across) * 100;
  const settings: Array<[keyof PlacedCue, unknown]> = [
    ['snapToLines', false],
    ['line', Math.min(100, line)],
    ['position', Math.min(100, position)],
    ['size', Math.min(100, (layout.columns / (wide ? 42 : 32)) * 100)],
    ['align', ALIGN[layout.justify]],
    ['lineAlign', LINE_ALIGN[Math.floor(layout.anchorPoint / 3)]],
    ['positionAlign', POSITION_ALIGN[layout.anchorPoint % 3]],
  ];
  for (const [key, value] of settings) {
    try {
      (placed as unknown as Record<string, unknown>)[key] = value;
    } catch {
      // An enum value this browser does not know.
    }
  }
  placed.cea708 = { window: cue.window, ...layout };
}

export default function textCea708(): Stage {
  return {
    name: 'text-cea708',
    provides: ['text-cea708', { contentType: 'text', mimeType: MIME }],
    requires: [['nal-scan', 'ts-transmux']],
    install(ctx) {
      const dtvcc = new Dtvcc();
      const captions = inbandCaptions(ctx, MIME, 'cea708');

      const unregister = registerCaptionConsumer((packets) => {
        for (const packet of packets) {
          for (const triple of packet.triples) {
            if (triple.type >= 2) dtvcc.push(triple.type, triple.a, triple.b, packet.time);
          }
        }
        const video = ctx.element as HTMLVideoElement;
        // 16:9 unless the picture says otherwise.
        const wide = !(video.videoHeight > 0 && video.videoWidth / video.videoHeight < 1.5);
        for (const [service, cues] of dtvcc.drain()) {
          const native: TextTrackCue[] = [];
          for (const cue of cues) {
            const made = vttCue(cue.start, cue.end, cue.text);
            if (made === null) continue;
            place(made, cue, wide);
            native.push(made);
          }
          captions.show(`SERVICE${service}`, native);
        }
      });

      return () => {
        unregister();
        captions.dispose();
      };
    },
  };
}
