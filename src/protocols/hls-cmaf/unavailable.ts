/**
 * What a playlist that cannot be used means for playback. Pure; shared by
 * hls-cmaf (a playlist that fails to load) and hls-live (a playlist that
 * keeps failing to reload). Each keeps its own constraint source, because
 * CONSTRAIN replaces a source's constraint and two slices writing one source
 * in the same turn would erase each other's exclusions.
 */
import { isTrick } from '../../kernel/presentation.js';
import { withDeadGroups } from '../../kernel/rendition-select.js';
import type { MatteboxError } from '../../types/error.js';
import type { Presentation } from '../../types/ir.js';
import type { KernelState } from '../../types/kernel.js';
import type { Message } from '../../types/messages.js';

/** Renditions whose playlist failed to load (hls-cmaf). */
export const LOAD_FAILED = 'hls:unavailable';
/** Renditions whose playlist kept failing to reload (hls-live). */
export const RELOAD_FAILED = 'hls-live:unavailable';

type Source = typeof LOAD_FAILED | typeof RELOAD_FAILED;

/**
 * What `source` excludes for the failed renditions in `ids`, together with
 * the other source: `excluded` is everything out, `own` the part `source`
 * writes. A source writes its own failures, and a variant a dead audio group
 * drags along that the other source does not exclude already. Writing the
 * other source's renditions too would keep them out after that source
 * readmits them.
 */
function exclusion(
  presentation: Presentation,
  kernel: Readonly<KernelState>,
  source: Source,
  ids: readonly string[],
): { readonly excluded: ReadonlySet<string>; readonly own: readonly string[] } {
  const other = source === LOAD_FAILED ? RELOAD_FAILED : LOAD_FAILED;
  const otherIds = new Set(kernel.quality.constraints.get(other)?.excludeIds ?? []);
  const excluded = withDeadGroups(presentation, new Set([...ids, ...otherIds]));
  const own = [...excluded].filter((id) => ids.includes(id) || !otherIds.has(id));
  return { excluded, own };
}

/**
 * The messages that stop relying on the renditions in `ids`, the whole list
 * `source` excludes. A failed audio group takes the variants that require
 * it, so arbitration moves to a variant on a working group and alt-audio
 * follows. A CONSTRAIN when playback can go on; a fatal MANIFEST_FAILED
 * when a video track has no rendition left, or when the active audio track
 * has none and no variant names an audio group to move to.
 */
export function unavailableMessages(
  kernel: Readonly<KernelState>,
  source: Source,
  ids: readonly string[],
  error: MatteboxError,
): readonly Message[] {
  const presentation = kernel.presentation;
  if (presentation === null) return [];
  const { excluded, own } = exclusion(presentation, kernel, source, ids);
  const grouped = presentation.couplings.some((c) => c.requires.audio !== undefined);
  const activeAudio = kernel.tracks.active.get('audio');
  const gone = presentation.periods.some((period) =>
    period.tracks.some(
      (track) =>
        track.renditions.length > 0 &&
        track.renditions.every((r) => excluded.has(r.id)) &&
        ((track.contentType === 'video' && !isTrick(track)) ||
          (track.id === activeAudio && !grouped)),
    ),
  );
  if (gone) return [{ type: 'MANIFEST_FAILED', error: { ...error, fatal: true } }];
  return [{ type: 'CONSTRAIN', source, constraint: { excludeIds: [...own] } }];
}

/**
 * The CONSTRAIN for what `source` still excludes once some of its failures
 * are readmitted: `ids` is the shorter list. Fewer exclusions never stop
 * playback, so there is no failure to report.
 */
export function readmitMessage(
  kernel: Readonly<KernelState>,
  source: Source,
  ids: readonly string[],
): Message | null {
  const presentation = kernel.presentation;
  if (presentation === null) return null;
  const { own } = exclusion(presentation, kernel, source, ids);
  return { type: 'CONSTRAIN', source, constraint: { excludeIds: [...own] } };
}
