/**
 * Reads how a 360° video's picture maps onto a sphere from the boxes of its
 * init segment, for a stream whose manifest does not say. Two box families
 * carry it inside the video's sample entry, and they share the fourccs
 * `proj` and `equi` with different contents, so each is read under its own
 * parent:
 *
 * - Apple's Video Extended Usage, `vexu/proj/prji` (Apple, "Stereo Video
 *   ISOBMFF Extensions"):
 *   https://developer.apple.com/av-foundation/Stereo-Video-ISOBMFF-Extensions.pdf
 *   `prji` is a FullBox holding `projection_kind`, a fourcc: `equi` for 360°,
 *   `hequ` for 180°. These are the kinds HLS `REQ-VIDEO-LAYOUT` names
 *   `PROJ-EQUI` and `PROJ-HEQU`. Shaka Player reads the same boxes:
 *   https://github.com/shaka-project/shaka-player/blob/v5.3.6/lib/media/streaming_engine.js#L2845-L2910
 * - Google's Spherical Video V2, `sv3d/proj/equi`:
 *   https://github.com/google/spatial-media/blob/2308497c39bb604a7c3ba56ac17e302f2b1b6a96/docs/spherical-video-v2-rfc.md
 *   `equi` is a FullBox with four 0.32 fixed-point bounds, the share of the
 *   sphere cropped from the top, bottom, left and right. Media3 reads
 *   `sv3d` in the same place:
 *   https://github.com/androidx/media/blob/1.11.1/libraries/extractor/src/main/java/androidx/media3/extractor/mp4/BoxParser.java
 *
 * A cube map, a mesh, a fisheye, or bounds that crop anything else read as
 * no projection: the engine names only what a player can draw from these
 * two kinds.
 */
import type { Rendition } from '../types/ir.js';
import {
  findBox,
  findBoxes,
  fourcc,
  fullBox,
  sampleEntries,
  VISUAL_ENTRY_HEADER,
  viewOf,
} from './mp4-box/index.js';

/** A projection the IR names. */
type Projection = NonNullable<Rendition['projection']>;

/** A quarter of the sphere's width in 0.32 fixed point: 0.25 × 2³². */
const QUARTER = 0x40000000;

/** The box `type` under `parent`, or null. Each step searches one level of children. */
function under(parent: Uint8Array, ...path: string[]): Uint8Array | null {
  let at: Uint8Array | null = parent;
  for (const type of path) {
    if (at === null) return null;
    at = findBox(at, type)?.payload ?? null;
  }
  return at;
}

/** Apple's `prji` kind: `equi` is 360°, `hequ` 180°. */
function apple(children: Uint8Array): Projection | null {
  const prji = under(children, 'vexu', 'proj', 'prji');
  const body = prji === null ? undefined : fullBox(prji)?.body;
  if (body === undefined || body.byteLength < 4) return null;
  const kind = fourcc(body, 0);
  return kind === 'equi' ? 'equirectangular' : kind === 'hequ' ? 'half-equirectangular' : null;
}

/**
 * Google's `equi` bounds. Nothing cropped is the whole sphere. A quarter
 * cropped from the left and from the right leaves the front half, 180°
 * wide and full height: what a half-equirectangular picture covers.
 */
function google(children: Uint8Array): Projection | null {
  const equi = under(children, 'sv3d', 'proj', 'equi');
  const body = equi === null ? undefined : fullBox(equi)?.body;
  if (body === undefined || body.byteLength < 16) return null;
  const view = viewOf(body);
  const [top, bottom, left, right] = [0, 4, 8, 12].map((at) => view.getUint32(at));
  if (top !== 0 || bottom !== 0) return null;
  if (left === 0 && right === 0) return 'equirectangular';
  return left === QUARTER && right === QUARTER ? 'half-equirectangular' : null;
}

/**
 * The projection the first video track's sample entry states, or null for
 * a flat picture, another projection, or bytes that are not an init
 * segment. Never throws.
 */
export function readProjection(init: Uint8Array): Projection | null {
  for (const trak of findBoxes(init, 'moov/trak')) {
    // ISO/IEC 14496-12 §8.4.3: hdlr is a FullBox, then pre_defined(32), then handler_type.
    const hdlr = findBox(trak.payload, 'mdia/hdlr');
    const handler = hdlr === null ? undefined : fullBox(hdlr.payload)?.body;
    if (handler === undefined || handler.byteLength < 8 || fourcc(handler, 4) !== 'vide') continue;
    const stsd = findBox(trak.payload, 'mdia/minf/stbl/stsd');
    if (stsd === null) continue;
    for (const entry of sampleEntries(stsd.payload)) {
      if (entry.body.byteLength < VISUAL_ENTRY_HEADER) continue;
      // An encrypted entry (encv) keeps these boxes too, beside its sinf.
      const children = entry.body.subarray(VISUAL_ENTRY_HEADER);
      const found = apple(children) ?? google(children);
      if (found !== null) return found;
    }
  }
  return null;
}
