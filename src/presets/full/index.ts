/**
 * The `full` preset: `dual-ts-drm` with low-latency HLS, low-latency DASH
 * and live catch-up (`hls-ll` and `dash-ll` in place of the plain lines), plus the accessories: thumbnails (fetches image playlists, so opt-in elsewhere), chapters
 * (loads a file the app names), trick play (a UI control drives it),
 * timed metadata (a page reads it), CEA-708 captions (US broadcast
 * streams carry 608 beside them, which the base reads), TTML subtitles
 * (opt-in by the owner's decision), HDR by capability (it excludes HDR
 * where nothing is known, which a page may not want by default), local
 * QoE metrics, CMSD (it acts on response headers a CDN must expose), and
 * localized rendition names (a menu reads them).
 * CMCD is in no preset: it changes every request, which costs a page that
 * never asked for it. A page adds the stage.
 * Feature parity with
 * videojs-http-streaming; the modularity claim is measured against it, and
 * the main CDN bundle exposes it.
 */
import chapters from '../../stages/chapters/index.js';
import cmsd from '../../stages/cmsd/index.js';
import hdr from '../../stages/hdr/index.js';
import qoe from '../../stages/qoe/index.js';
import renditionNames from '../../stages/rendition-names/index.js';
import textCea708 from '../../stages/text-cea708/index.js';
import textTtml from '../../stages/text-ttml/index.js';
import thumbnails from '../../stages/thumbnails/index.js';
import timedMetadata from '../../stages/timed-metadata/index.js';
import trickPlay from '../../stages/trick-play/index.js';
import { definePreset } from '../define.js';
import { base, dashLlLine, drmTier, hlsLlLine, lowLatencyTier, tsTier } from '../tiers.js';

const preset = definePreset('full', () => [
  ...hlsLlLine(),
  ...dashLlLine(),
  ...lowLatencyTier(),
  ...base(),
  ...tsTier(),
  ...drmTier(),
  thumbnails(),
  chapters(),
  trickPlay(),
  timedMetadata(),
  textCea708(),
  textTtml(),
  hdr(),
  qoe(),
  cmsd(),
  renditionNames(),
]);
export default preset;
export type { Preset, PresetOptions, PresetStageOptions } from '../define.js';
