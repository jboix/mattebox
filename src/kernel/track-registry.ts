/**
 * Generic track enumeration and selection, the engine.tracks surface.
 * Tracks whose content type has no registered sink are enumerated but not
 * selectable: that is how a deployment without text-webvtt degrades
 * gracefully instead of crashing.
 */
import type { TracksApi } from '../types/facade.js';
import type { ContentType, Track, TrackId } from '../types/ir.js';
import type { KernelState } from '../types/kernel.js';
import type { Command } from '../types/messages.js';

export interface TrackRegistryDeps {
  getState(): KernelState;
  dispatch(cmd: Command): void;
  emitEvent(event: string, payload: unknown): void;
  /** Whether a sink is registered for the content type, from the bus registry. */
  hasSink(contentType: ContentType): boolean;
}

export interface TrackRegistry extends TracksApi {
  selectable(trackId: TrackId): boolean;
}

function allTracks(state: KernelState): readonly Track[] {
  if (state.presentation === null) return [];
  return state.presentation.periods.flatMap((period) => period.tracks);
}

export function createTrackRegistry(deps: TrackRegistryDeps): TrackRegistry {
  function find(trackId: TrackId): Track | null {
    return allTracks(deps.getState()).find((track) => track.id === trackId) ?? null;
  }

  return {
    get available(): readonly Track[] {
      return allTracks(deps.getState());
    },
    active(contentType) {
      const activeId = deps.getState().tracks.active.get(contentType);
      if (activeId === undefined) return null;
      return find(activeId);
    },
    selectable(trackId) {
      const track = find(trackId);
      return track !== null && deps.hasSink(track.contentType);
    },
    select(trackId) {
      const track = find(trackId);
      if (track !== null && !deps.hasSink(track.contentType)) {
        // Selecting a track nothing can render is refused up front; the
        // reducer cannot see the sink registry, so the check lives here.
        deps.emitEvent('command:rejected', {
          command: 'SELECT_TRACK',
          reason: `no sink registered for '${track.contentType}'`,
        });
        return;
      }
      deps.dispatch({ type: 'SELECT_TRACK', trackId });
    },
    deselect(contentType) {
      deps.dispatch({ type: 'DESELECT_TRACK', contentType });
    },
  };
}
