/**
 * HDR by capability: keeps PQ and HLG renditions off a screen or decoder
 * that cannot show them, and plays them where it can. It runs when a
 * presentation with an HDR rendition loads, and answers in this order:
 *
 * 1. The integrator's answer, `hdr({ supported })`: a value or a function.
 *    A TV app passes its platform's answer here. It overrides the probes.
 * 2. The display: `matchMedia('(dynamic-range: high)')`, trusted only when
 *    the browser knows the feature (one of `high` and `standard` matches).
 * 3. The decoder: `mediaCapabilities.decodingInfo` with `transferFunction`
 *    and `colorGamut`, per HDR format in the ladder, trusted only when the
 *    browser knows those fields. A browser that does not know them answers
 *    for the codec alone, so the stage first asks with an invalid
 *    `hdrMetadataType`: a browser that knows the field rejects the call.
 * 4. Neither known, no option: HDR is excluded. A track with only HDR
 *    renditions drops the constraint and plays HDR, since the selector
 *    never empties a track. A washed-out picture on an SDR screen is worse
 *    than SDR on an HDR one.
 *
 * The answer is the `hdr` constraint source: `{ hdr: false }`, or the
 * unsupported formats' rendition ids, or nothing. A display change (a window
 * moved to another screen) asks again.
 */
import type { Rendition } from '../../types/ir.js';
import type { Stage } from '../../types/stage.js';

export interface HdrOptions {
  /** The platform's answer, which overrides the probes. */
  readonly supported?: boolean | (() => boolean | Promise<boolean>);
}

export interface HdrApi {
  /** Whether the display shows HDR; null when the browser cannot tell. */
  readonly display: boolean | null;
  /** Per HDR format in the ladder (`codecs|range`), whether the decoder plays it; null when unknown. */
  readonly formats: Readonly<Record<string, boolean | null>>;
  /** What decided: the option, the probes, or the default. Null before an HDR presentation. */
  readonly source: 'option' | 'probe' | 'default' | null;
  /** Whether HDR renditions may play. */
  readonly allowed: boolean;
}

declare module '../../index.js' {
  interface MatteboxNamespaces {
    hdr: HdrApi;
  }
}

const SOURCE = 'hdr';

/** The display's answer, or null when the browser does not know `dynamic-range`. */
function displayHdr(): boolean | null {
  if (typeof matchMedia !== 'function') return null;
  if (matchMedia('(dynamic-range: high)').matches) return true;
  return matchMedia('(dynamic-range: standard)').matches ? false : null;
}

interface Capabilities {
  decodingInfo(config: object): Promise<{ supported: boolean }>;
}

function capabilities(): Capabilities | null {
  return (navigator as { mediaCapabilities?: Capabilities }).mediaCapabilities ?? null;
}

/** True when `decodingInfo` reads the HDR fields: an invalid enum value is then a TypeError. */
async function knowsHdrFields(api: Capabilities): Promise<boolean> {
  try {
    await api.decodingInfo({
      type: 'media-source',
      video: {
        contentType: 'video/mp4; codecs="avc1.42E01E"',
        width: 640,
        height: 360,
        bitrate: 1_000_000,
        framerate: 30,
        hdrMetadataType: 'unknown',
      },
    });
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}

function isHdr(rendition: Rendition): boolean {
  return rendition.videoRange === 'PQ' || rendition.videoRange === 'HLG';
}

const formatOf = (rendition: Rendition): string =>
  `${rendition.codecs ?? ''}|${rendition.videoRange}`;

export default function hdr(options: HdrOptions = {}): Stage {
  return {
    name: 'hdr',
    provides: ['hdr'],
    requires: ['rendition-select'],
    install(ctx) {
      let state: HdrApi = { display: null, formats: {}, source: null, allowed: true };
      let seen: unknown = null;
      let run = 0;
      let constrained = false;

      function videoRenditions(): Rendition[] {
        const out: Rendition[] = [];
        for (const period of ctx.getState().presentation?.periods ?? []) {
          for (const track of period.tracks) {
            if (track.contentType === 'video') out.push(...track.renditions);
          }
        }
        return out;
      }
      const hdrRenditions = (): Rendition[] => videoRenditions().filter(isHdr);

      function apply(excluded: readonly Rendition[] | 'all' | 'none'): void {
        // With nothing but HDR to play, play it: no constraint, no warning.
        const nothingElse = excluded === 'all' && videoRenditions().every(isHdr);
        if (nothingElse || excluded === 'none' || (excluded !== 'all' && excluded.length === 0)) {
          if (constrained) ctx.dispatch({ type: 'RELEASE_CONSTRAINT', source: SOURCE });
          constrained = false;
          return;
        }
        constrained = true;
        ctx.dispatch({
          type: 'CONSTRAIN',
          source: SOURCE,
          constraint:
            excluded === 'all' ? { hdr: false } : { excludeIds: excluded.map((r) => r.id) },
        });
      }

      async function evaluate(): Promise<void> {
        run += 1;
        const mine = run;
        const renditions = hdrRenditions();
        if (renditions.length === 0) {
          state = { display: null, formats: {}, source: null, allowed: true };
          apply('none');
          return;
        }
        const display = displayHdr();
        if (options.supported !== undefined) {
          const answer =
            typeof options.supported === 'function' ? await options.supported() : options.supported;
          if (mine !== run) return;
          state = { display, formats: {}, source: 'option', allowed: answer };
          apply(answer ? 'none' : 'all');
          return;
        }
        // One probe per distinct format, where the browser reads the HDR fields.
        const formats: Record<string, boolean | null> = {};
        const api = capabilities();
        const known = api !== null && (await knowsHdrFields(api));
        for (const rendition of renditions) {
          const key = formatOf(rendition);
          if (key in formats) continue;
          formats[key] = null;
          if (!known || api === null) continue;
          try {
            const info = await api.decodingInfo({
              type: 'media-source',
              video: {
                contentType: `video/mp4; codecs="${rendition.codecs ?? ''}"`,
                width: rendition.width ?? 1920,
                height: rendition.height ?? 1080,
                bitrate: rendition.bitrate || 5_000_000,
                framerate: rendition.frameRate ?? 30,
                transferFunction: rendition.videoRange === 'HLG' ? 'hlg' : 'pq',
                colorGamut: 'rec2020',
              },
            });
            formats[key] = info.supported;
          } catch {
            formats[key] = false;
          }
        }
        if (mine !== run) return;
        if (display === null && !known) {
          state = { display, formats, source: 'default', allowed: false };
          apply('all');
          return;
        }
        if (display === false) {
          state = { display, formats, source: 'probe', allowed: false };
          apply('all');
          return;
        }
        const unsupported = renditions.filter((r) => formats[formatOf(r)] === false);
        state = {
          display,
          formats,
          source: 'probe',
          allowed: unsupported.length < renditions.length,
        };
        apply(unsupported.length === renditions.length ? 'all' : unsupported);
      }

      function onPresentation(): void {
        const presentation = ctx.getState().presentation;
        if (presentation === seen) return;
        seen = presentation;
        void evaluate();
      }

      // A window moved to another display: the answer may change.
      const query = typeof matchMedia === 'function' ? matchMedia('(dynamic-range: high)') : null;
      const onChange = (): void => {
        void evaluate();
      };
      if (query !== null) {
        // Safari before 14 has MediaQueryList without EventTarget.
        if (typeof query.addEventListener === 'function')
          query.addEventListener('change', onChange);
        else query.addListener(onChange);
      }
      const off = ctx.on('tracks:changed', onPresentation);
      ctx.registerNamespace('hdr', {
        get display() {
          return state.display;
        },
        get formats() {
          return state.formats;
        },
        get source() {
          return state.source;
        },
        get allowed() {
          return state.allowed;
        },
      } satisfies HdrApi);
      return () => {
        run += 1;
        off();
        if (query !== null) {
          if (typeof query.removeEventListener === 'function') {
            query.removeEventListener('change', onChange);
          } else query.removeListener(onChange);
        }
      };
    },
  };
}
