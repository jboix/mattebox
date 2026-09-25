/**
 * The `AxB` pair both manifest families write for sizes and grids: HLS
 * RESOLUTION and LAYOUT (RFC 8216 §4.3.4.2, the Roku image-playlist tags),
 * and the DASH-IF thumbnail_tile value. One copy serves both adapters.
 */

/** `1280x720` or `10x1` into two positive integers, or null. */
export function dimensions(value: string | null | undefined): [number, number] | null {
  const match = /^(\d+)x(\d+)$/.exec(value ?? '');
  const a = Number(match?.[1]);
  const b = Number(match?.[2]);
  return a > 0 && b > 0 ? [a, b] : null;
}
