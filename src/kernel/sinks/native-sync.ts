/**
 * Keeps a stage's native TextTracks and the engine's text selection in step,
 * both ways, for the subtitle formats (`text-formats.ts`) and the in-band
 * caption formats (`caption-tracks.ts`). Engine to element: the selected
 * track's native track shows, the others go idle. Element to engine: a pick
 * in the browser's caption menu selects the track, and turning captions off
 * there deselects. Each stage mirrors only its own tracks; another stage's
 * track is its own to mirror.
 */
import type { Track } from '../../types/ir.js';
import type { StageContext } from '../../types/stage.js';

export interface NativeSync {
  /** The tracks this stage mirrors. */
  tracks(): readonly Track[];
  /** A track's native track, created when `create`; null when it has none yet. */
  native(track: Track, create: boolean): TextTrack | null;
  /** An unselected native track's mode: `disabled`, or `hidden` to keep cues arriving. */
  readonly idle: 'hidden' | 'disabled';
  /** Runs before each pass from the engine to the element. */
  before?(): void;
}

/** Starts the sync; returns its teardown. */
export function syncNativeTracks(ctx: StageContext, sync: NativeSync): () => void {
  const activeId = (): string | undefined => ctx.getState().tracks.active.get('text');

  function mirror(): void {
    sync.before?.();
    const active = activeId();
    for (const track of sync.tracks()) {
      const showing = track.id === active;
      const native = sync.native(track, showing);
      if (native === null) continue;
      const mode = showing ? 'showing' : sync.idle;
      if (native.mode !== mode) native.mode = mode;
    }
  }

  // Fires for the mirror's own writes too; those find the engine in step.
  function onNativeChange(): void {
    const active = activeId();
    const tracks = sync.tracks();
    const showing = tracks.find((track) => sync.native(track, false)?.mode === 'showing');
    if (showing !== undefined) {
      if (showing.id !== active) ctx.dispatch({ type: 'SELECT_TRACK', trackId: showing.id });
    } else if (tracks.some((track) => track.id === active)) {
      ctx.dispatch({ type: 'DESELECT_TRACK', contentType: 'text' });
    }
  }

  const offChanged = ctx.on('tracks:changed', mirror);
  const offSelected = ctx.on('tracks:selected', (payload) => {
    if ((payload as { contentType?: string }).contentType === 'text') mirror();
  });
  ctx.element.textTracks.addEventListener('change', onNativeChange);
  return () => {
    offChanged();
    offSelected();
    ctx.element.textTracks.removeEventListener('change', onNativeChange);
  };
}
