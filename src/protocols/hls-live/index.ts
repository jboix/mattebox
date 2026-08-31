/**
 * HLS live: the edge is read, never computed. A slice reducer reloads the
 * active playlists on the TARGETDURATION cadence, reconciles the sliding
 * window as absorb-a-fact-derive-the-diff (seqs stay stable across reloads
 * because they come from MEDIA-SEQUENCE, so replacing the segment list IS
 * the diff for scheduling), and reports the availability window through
 * LIVE_WINDOW_CHANGED facts. EXT-X-ENDLIST converts the presentation to
 * VOD and the reload loop dies with it.
 *
 * One playlist drives the window (the active video rendition, or audio for
 * an audio-only presentation); every other active track's playlist (the
 * audio group's rendition, a segmented subtitle playlist) reloads on the
 * same tick as a companion, the way videojs-http-streaming runs a playlist
 * loader per media type. A companion left stale drains once playback
 * passes the edge it was fetched at, which looks like a live stream dying
 * a minute in.
 */
import type { Presentation, Rendition } from '../../types/ir.js';
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { Effect, Message } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';
import { mergePlaylist, parseMediaPlaylist } from '../hls-cmaf/parse.js';
import { registerLiveNamespace } from '../live-shared.js';

const REFRESH_TOKEN = 'hls:live:refresh';
const TICK_TOKEN = 'hls-live:reload';

interface ReloadTarget {
  readonly url: string;
  readonly renditionId: string;
  /** Another rung of the video ladder, reloaded at a slower cadence. */
  readonly ladder: boolean;
}

interface HlsLiveSlice {
  readonly manifestUrl: string | null;
  /** The playlist URL and rendition that drive the window and the cadence. */
  readonly target: ReloadTarget | null;
  /** Playlists of the other active tracks, reloaded on the same tick. */
  readonly companions: readonly ReloadTarget[];
  /** Ticks so far; ladder companions reload every LADDER_EVERY ticks. */
  readonly round: number;
  /**
   * A reload tick is scheduled. The loop is one chain: at most one tick
   * pending and at most one target reload in flight, so neither the
   * MANIFEST_LOADED every companion feeds nor the reload a switch fires at
   * once can fork it into two.
   */
  readonly tickPending: boolean;
  /** The rendition whose reload is in flight as the target's, or null. */
  readonly inflight: string | null;
  /** Last seen final sequence number; an unchanged reload halves the cadence. */
  readonly lastEndSeq: number;
  /**
   * The window rendition changed and its playlist may be stale: the window
   * holds until that playlist reloads, so a switch never reports an edge
   * from the past.
   */
  readonly awaitingTarget: boolean;
}

const INITIAL: HlsLiveSlice = {
  manifestUrl: null,
  target: null,
  companions: [],
  round: 0,
  tickPending: false,
  inflight: null,
  lastEndSeq: -1,
  awaitingTarget: false,
};

/**
 * A two-hour DVR playlist is tens of kilobytes; reloading four of them every
 * target duration saturates a slow link. The audio and text companions keep
 * the full cadence because playback consumes them; the other video rungs
 * only need to be fresh enough for a switch, which reloads the new target
 * at once anyway.
 */
const LADDER_EVERY = 3;

/**
 * Every reload names its rendition in the token, the target's included. A
 * response is merged into the rendition it was fetched for, never into
 * whichever rendition is the target when it lands: a switch while a
 * reload is in flight would otherwise file one rendition's segment URLs
 * under another, and the scheduler would then append the wrong bytes under
 * a matching rendition id, which no init guard can catch.
 */
function refreshToken(renditionId: string): string {
  return `${REFRESH_TOKEN}:${renditionId}`;
}

function renditionOfToken(token: string): string | null {
  return token.startsWith(`${REFRESH_TOKEN}:`) ? token.slice(REFRESH_TOKEN.length + 1) : null;
}

function findRendition(presentation: Presentation, renditionId: string): Rendition | null {
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.id === renditionId) return rendition;
      }
    }
  }
  return null;
}

/**
 * The active tracks' playlists other than the window rendition's: every
 * other video rendition, the audio group rendition, a segmented subtitle
 * playlist. The whole video ladder reloads because a switch can only land
 * on a rendition whose playlist reaches the playhead; one left at its
 * startup window can never be scheduled from, so the switch never happens.
 * Renditions without a playlist of their own (muxed audio, a text track in
 * a single file) need no reload.
 */
function companionTargets(
  presentation: Presentation,
  kernel: Readonly<KernelState>,
  windowRenditionId: string | null,
): ReloadTarget[] {
  const activeIds = new Set(
    (['video', 'audio', 'text'] as const)
      .map((contentType) => kernel.tracks.active.get(contentType))
      .filter((id): id is string => id !== undefined),
  );
  const out: ReloadTarget[] = [];
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      if (!activeIds.has(track.id)) continue;
      for (const rendition of track.renditions) {
        if (rendition.id === windowRenditionId || rendition.playlistUrl === undefined) continue;
        out.push({
          url: rendition.playlistUrl,
          renditionId: rendition.id,
          ladder: track.contentType === 'video',
        });
      }
    }
  }
  return out;
}

/** Loops a message back into the bus through a zero-delay schedule effect. */
function feed(message: Message): Effect {
  // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
  return { kind: 'schedule', token: 'hls-live:loopback', delayMs: 0, then: message };
}

function tick(delaySeconds: number): Effect {
  return {
    kind: 'schedule',
    token: TICK_TOKEN,
    delayMs: Math.max(500, delaySeconds * 1000),
    // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
    then: { type: 'TICK', token: TICK_TOKEN },
  };
}

/**
 * The rendition whose playlist drives the live window: the active video
 * rendition, else the first with segments. Video leads, but an audio-only
 * presentation (a radio or packed-audio DVR stream) has no video track, so
 * audio drives the window there.
 */
function windowRendition(
  presentation: Presentation,
  kernel: Readonly<KernelState>,
): Rendition | null {
  let fallback: Rendition | null = null;
  for (const contentType of ['video', 'audio'] as const) {
    for (const period of presentation.periods) {
      for (const track of period.tracks) {
        if (track.contentType !== contentType) continue;
        for (const rendition of track.renditions) {
          if (!Array.isArray(rendition.segments) || rendition.segments.length === 0) continue;
          if (rendition.id === kernel.quality.active) return rendition;
          fallback = fallback ?? rendition;
        }
      }
    }
    if (fallback !== null) return fallback;
  }
  return fallback;
}

/**
 * The window fact for the rendition's current segment list, or null when
 * the kernel already holds exactly that window: every companion reload
 * feeds a MANIFEST_LOADED, and a window that has not moved is not news.
 */
function windowFact(
  presentation: Presentation,
  rendition: Rendition,
  kernel: Readonly<KernelState>,
): Effect | null {
  const segments = rendition.segments;
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first === undefined || last === undefined) return null;
  const end = last.start + last.duration;
  const holdBack =
    presentation.live?.holdBack ?? 3 * (presentation.live?.updatePeriod ?? last.duration);
  const start = first.start;
  const edge = Math.max(start, end - holdBack);
  const known = kernel.live;
  if (
    known !== null &&
    known.span.start === start &&
    known.span.end === end &&
    known.edge === edge
  ) {
    return null;
  }
  return feed({ type: 'LIVE_WINDOW_CHANGED', start, end, edge });
}

/** The playlist URL a rendition's reload resolves against. */
function playlistUrlFor(
  presentation: Presentation,
  renditionId: string,
  target: ReloadTarget | null,
): string | null {
  const rendition = findRendition(presentation, renditionId);
  if (rendition?.playlistUrl !== undefined) return rendition.playlistUrl;
  // A bare media-playlist source: the rendition has no playlist of its own
  // and the manifest itself is reloaded as the target.
  return target !== null && target.renditionId === renditionId ? target.url : null;
}

const reduceHlsLive: SliceReducer<HlsLiveSlice> = (slice, msg, kernel) => {
  const state = slice ?? INITIAL;

  if (msg.type === 'LOAD') return [{ ...INITIAL, manifestUrl: msg.url }, []];
  if (msg.type === 'UNLOAD' || msg.type === 'DETACH') return [INITIAL, []];

  if (msg.type === 'MANIFEST_LOADED') {
    if (!msg.presentation.isLive) {
      return [{ ...state, target: null, companions: [], inflight: null }, []];
    }
    const rendition = windowRendition(msg.presentation, kernel);
    const effects: Effect[] = [];
    // The reload target: the rendition's own playlist when it has one, the
    // manifest itself for a bare media-playlist source.
    const url = rendition?.playlistUrl ?? state.manifestUrl;
    const target =
      url !== null && rendition !== null
        ? { url, renditionId: rendition.id, ladder: false }
        : state.target;
    const companions = companionTargets(msg.presentation, kernel, rendition?.id ?? null);
    const switched =
      state.target !== null && target !== null && target.renditionId !== state.target.renditionId;
    let awaitingTarget = state.awaitingTarget;
    let inflight = state.inflight;
    if (switched && target !== null) {
      // A quality switch moved the window onto a playlist last fetched at
      // startup. Reload it now and hold the window until it lands. A reload
      // of that very rendition already in flight serves the same purpose.
      if (inflight !== target.renditionId) {
        effects.push({ kind: 'fetch', token: refreshToken(target.renditionId), url: target.url });
        inflight = target.renditionId;
      }
      awaitingTarget = true;
    } else if (!awaitingTarget && rendition !== null) {
      const window = windowFact(msg.presentation, rendition, kernel);
      if (window !== null) effects.push(window);
    }
    // Only a dead loop (startup, or after ENDLIST) starts one.
    let tickPending = state.tickPending;
    if (!tickPending && inflight === null && target !== null) {
      effects.push(tick(msg.presentation.live?.updatePeriod ?? 4));
      tickPending = true;
    }
    return [{ ...state, target, companions, tickPending, inflight, awaitingTarget }, effects];
  }

  if (msg.type === 'TICK' && msg.token === TICK_TOKEN) {
    if (state.target === null || kernel.presentation?.isLive !== true) {
      return [{ ...state, tickPending: false, inflight: null }, []];
    }
    const effects: Effect[] = [];
    let inflight = state.inflight;
    // One target reload at a time: a second in flight would answer twice
    // and every answer schedules the next tick, forking the loop.
    if (inflight !== state.target.renditionId) {
      effects.push({
        kind: 'fetch',
        token: refreshToken(state.target.renditionId),
        url: state.target.url,
      });
      inflight = state.target.renditionId;
    }
    for (const companion of state.companions) {
      if (companion.ladder && state.round % LADDER_EVERY !== 0) continue;
      effects.push({
        kind: 'fetch',
        token: refreshToken(companion.renditionId),
        url: companion.url,
      });
    }
    // The target's answer schedules the next tick.
    return [{ ...state, round: state.round + 1, tickPending: false, inflight }, effects];
  }

  if (msg.type === 'SEGMENT_FAILED') {
    const renditionId = renditionOfToken(msg.trackId);
    if (renditionId === null) return [state, []];
    // A failed companion reload is nothing; a failed target reload is not
    // fatal either: try again soon rather than let the loop die.
    if (state.target === null || renditionId !== state.target.renditionId) return [state, []];
    if (state.tickPending) return [{ ...state, inflight: null }, []];
    return [{ ...state, inflight: null, tickPending: true }, [tick(2)]];
  }

  if (msg.type === 'SEGMENT_LOADED') {
    const renditionId = renditionOfToken(msg.trackId);
    if (renditionId === null || kernel.presentation === null) return [state, []];
    const isTarget = state.target !== null && renditionId === state.target.renditionId;
    const url = playlistUrlFor(kernel.presentation, renditionId, state.target);
    if (url === null) return [state, []];
    const text = new TextDecoder().decode(msg.bytes);
    const media = parseMediaPlaylist(text, url);
    if (media.playlist === null) {
      // A bad reload is not fatal: try again on the same cadence.
      if (!isTarget) return [state, []];
      if (state.tickPending) return [{ ...state, inflight: null }, []];
      return [{ ...state, inflight: null, tickPending: true }, [tick(2)]];
    }
    // Always merge, never re-parse: mergePlaylist rebases the new window onto
    // the running timeline, which a fresh parse of a bare media playlist would
    // throw away, stalling live once the first window drains.
    const refreshed = mergePlaylist(kernel.presentation, renditionId, media.playlist);
    const effects: Effect[] = [
      feed({
        type: 'PLAYLIST_REFRESHED',
        trackId: renditionId,
        renditionId,
        mediaSequence: media.playlist.mediaSequence,
        segments: media.playlist.segments,
      }),
      feed({ type: 'MANIFEST_LOADED', presentation: refreshed }),
    ];
    if (!isTarget) {
      // A companion, or the target of a moment ago: merged in, nothing
      // else. The window and the cadence belong to the target's reload.
      return [state, effects];
    }

    const lastSegment = media.playlist.segments[media.playlist.segments.length - 1];
    const endSeq = lastSegment?.seq ?? -1;
    const changed = endSeq !== state.lastEndSeq;
    const cadence = media.playlist.targetDuration || 4;
    // RFC 8216: full cadence after a changed reload, half after an
    // unchanged one. A switch's reload answers while the regular tick is
    // still pending: that tick carries on, this answer adds none. The
    // loop dies with ENDLIST.
    let tickPending = state.tickPending;
    if (!media.playlist.endlist && !tickPending) {
      effects.push(tick(changed ? cadence : cadence / 2));
      tickPending = true;
    }
    return [
      { ...state, lastEndSeq: endSeq, tickPending, inflight: null, awaitingTarget: false },
      effects,
    ];
  }

  return [state, []];
};

/** The stage factory. Requires hls-cmaf; the loader enforces it. */
export default function hlsLive(): Stage {
  return {
    name: 'hls-live',
    provides: ['hls-live'],
    requires: ['hls-cmaf'],
    install(ctx) {
      ctx.reduce('hls-live', reduceHlsLive as SliceReducer);
      registerLiveNamespace(ctx);
    },
  };
}
