/**
 * Alternate audio: a second media pipeline on sb:audio. The kernel already
 * schedules audio tracks generically, so this stage owns selection and
 * sync, not scheduling. Its core job is entanglement #2's other half:
 * switching the video rendition can change the required audio group, and
 * the audio track must follow, as one arbitration outcome.
 *
 * The coupling table carries the group each video rendition requires. This
 * slice watches the active video rendition; when its coupling names an
 * audio group the current audio track is not in, it selects a track in
 * that group — preferring the current language so a group switch does not
 * silently change languages.
 *
 * A user language choice is remembered and re-applied on top of every
 * group switch, so `alt-audio` never fights `engine.tracks.select`.
 */
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { Effect } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';

interface AltAudioSlice {
  /** The language the user last chose, sticky across group switches. */
  readonly preferredLang: string | null;
}

const INITIAL: AltAudioSlice = { preferredLang: null };

interface AudioTrackInfo {
  readonly id: string;
  readonly group: string;
  readonly lang: string | null;
  readonly isDefault: boolean;
}

/** Audio tracks with their group parsed from the `group:name` id convention. */
function audioTracks(kernel: Readonly<KernelState>): readonly AudioTrackInfo[] {
  const out: AudioTrackInfo[] = [];
  for (const period of kernel.presentation?.periods ?? []) {
    for (const track of period.tracks) {
      if (track.contentType !== 'audio') continue;
      const colon = track.id.indexOf(':');
      out.push({
        id: track.id,
        group: colon === -1 ? track.id : track.id.slice(0, colon),
        lang: track.lang ?? null,
        isDefault: track.role === 'main',
      });
    }
  }
  return out;
}

/** The audio group the active video rendition's coupling requires, or null. */
function requiredGroup(kernel: Readonly<KernelState>): string | null {
  const activeVideo = kernel.quality.active;
  if (activeVideo === null) return null;
  const coupling = kernel.presentation?.couplings.find((c) => c.renditionId === activeVideo);
  return coupling?.requires.audio ?? null;
}

/** Picks the audio track in `group`, preferring a language, then default, then first. */
function pickInGroup(
  tracks: readonly AudioTrackInfo[],
  group: string,
  preferredLang: string | null,
): AudioTrackInfo | null {
  const inGroup = tracks.filter((t) => t.group === group);
  if (inGroup.length === 0) return null;
  return (
    (preferredLang !== null ? inGroup.find((t) => t.lang === preferredLang) : undefined) ??
    inGroup.find((t) => t.isDefault) ??
    (inGroup[0] as AudioTrackInfo)
  );
}

/** Loops a command back into the bus through a zero-delay schedule effect. */
function select(trackId: string): Effect {
  return {
    kind: 'schedule',
    token: 'alt-audio:select',
    delayMs: 0,
    // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
    then: { type: 'SELECT_TRACK', trackId },
  };
}

const reduceAltAudio: SliceReducer<AltAudioSlice> = (slice, msg, kernel) => {
  const state = slice ?? INITIAL;

  if (msg.type === 'LOAD' || msg.type === 'UNLOAD' || msg.type === 'DETACH') {
    return [INITIAL, []];
  }

  // Remember an explicit audio selection as a language preference.
  if (msg.type === 'SELECT_TRACK') {
    const chosen = audioTracks(kernel).find((t) => t.id === msg.trackId);
    if (chosen?.lang != null) return [{ preferredLang: chosen.lang }, []];
    return [state, []];
  }

  // A manifest landing or a video rendition change may require a different
  // audio group. Reconcile the active audio track to it.
  if (msg.type === 'MANIFEST_LOADED' || msg.type === 'SEGMENT_LOADED') {
    const group = requiredGroup(kernel);
    if (group === null) return [state, []];
    const active = kernel.tracks.active.get('audio');
    const tracks = audioTracks(kernel);
    const activeInfo = tracks.find((t) => t.id === active);
    if (activeInfo !== undefined && activeInfo.group === group) return [state, []];
    const target = pickInGroup(tracks, group, state.preferredLang);
    if (target === undefined || target === null || target.id === active) return [state, []];
    return [state, [select(target.id)]];
  }

  return [state, []];
};

/** The stage factory. */
export default function altAudio(): Stage {
  return {
    name: 'alt-audio',
    provides: ['alt-audio'],
    // docs/06: audio group switching crosses codec boundaries, so the
    // changeType machinery must be present; the loader pulls codec-switch in.
    requires: ['scheduler', 'codec-switch'],
    install(ctx) {
      ctx.reduce('alt-audio', reduceAltAudio as SliceReducer);
    },
  };
}
