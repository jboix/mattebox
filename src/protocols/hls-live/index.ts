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

import { scheduled, tickAfter } from '../../kernel/effects.js';
import { findRendition } from '../../kernel/presentation.js';
import { activeRenditions } from '../../kernel/rendition-select.js';
import type { MatteboxError } from '../../types/error.js';
import type { Presentation, Rendition } from '../../types/ir.js';
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { Effect, Message } from '../../types/messages.js';
import type { Stage } from '../../types/stage.js';
import { parseMediaPlaylist, refreshFor } from '../hls-cmaf/parse.js';
import { RELOAD_FAILED, unavailableMessages } from '../hls-cmaf/unavailable.js';
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
   * PLAYLIST_REFRESHED every companion feeds nor the reload a switch fires at
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
  /** SUSPEND stopped the loop; RESUME restarts it. */
  readonly suspended: boolean;
  /** Consecutive failed reloads per rendition. A success clears the count. */
  readonly failures: Readonly<Record<string, number>>;
  /** Renditions that failed FAILURE_LIMIT times in a row and are no longer reloaded. */
  readonly abandoned: readonly string[];
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
  suspended: false,
  failures: {},
  abandoned: [],
};

/**
 * Failed reloads of one playlist in a row before the loop gives up on it.
 * Each reload already carries the transport's own retries, so this is
 * several rounds of a playlist that does not answer: an expired token, a
 * stream that ended without ENDLIST. The playlist is then abandoned and
 * playback moves off it. Retrying forever only keeps the network busy for
 * a stream that cannot play.
 */
const FAILURE_LIMIT = 4;

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

/** A reload of one playlist. The rendition rides along so a failure counts toward steering failover. */
function reload(target: { readonly renditionId: string; readonly url: string }): Effect {
  return {
    kind: 'fetch',
    token: refreshToken(target.renditionId),
    url: target.url,
    renditionId: target.renditionId,
  };
}

function renditionOfToken(token: string): string | null {
  return token.startsWith(`${REFRESH_TOKEN}:`) ? token.slice(REFRESH_TOKEN.length + 1) : null;
}

/**
 * The active tracks' playlists other than the window rendition's: the audio
 * group rendition, a segmented subtitle playlist, and the video rungs next
 * to the window rendition. A switch can only land on a rendition whose
 * playlist reaches the playhead, and ABR steps one rung at a time, so the
 * neighbours stay fresh; a longer jump reloads its target at once (the
 * switch branch). Reloading the whole ladder saturates the link on a large
 * multivariant playlist. Renditions without a playlist of their own (muxed
 * audio, a text track in a single file) need no reload, and a playlist
 * shared by several renditions reloads once.
 */
function companionTargets(
  kernel: Readonly<KernelState>,
  window: Rendition | null,
  abandoned: readonly string[],
): ReloadTarget[] {
  const urls = new Set<string>();
  if (window?.playlistUrl !== undefined) urls.add(window.playlistUrl);
  const out: ReloadTarget[] = [];
  const add = (rendition: Rendition, ladder: boolean) => {
    const url = rendition.playlistUrl;
    if (url === undefined || urls.has(url) || abandoned.includes(rendition.id)) return;
    urls.add(url);
    out.push({ url, renditionId: rendition.id, ladder });
  };
  // Without a window rendition there is no ladder position to reload around.
  const types =
    window === null
      ? (['audio', 'text', 'image'] as const)
      : (['video', 'audio', 'text', 'image'] as const);
  for (const { contentType, rendition } of activeRenditions(kernel, types, window?.id ?? null)) {
    add(rendition, contentType === 'video');
  }
  return out;
}

/** Loops a message back into the bus through a zero-delay schedule effect. */
function feed(message: Message): Effect {
  return scheduled('hls-live:loopback', message);
}

function tick(delaySeconds: number): Effect {
  return tickAfter(TICK_TOKEN, Math.max(500, delaySeconds * 1000));
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
  abandoned: readonly string[],
): Rendition | null {
  let fallback: Rendition | null = null;
  for (const contentType of ['video', 'audio'] as const) {
    for (const period of presentation.periods) {
      for (const track of period.tracks) {
        if (track.contentType !== contentType) continue;
        for (const rendition of track.renditions) {
          if (!Array.isArray(rendition.segments) || rendition.segments.length === 0) continue;
          if (abandoned.includes(rendition.id)) continue;
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
 * feeds a PLAYLIST_REFRESHED, and a window that has not moved is not news.
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
  const rendition = findRendition(presentation, renditionId)?.rendition;
  if (rendition?.playlistUrl !== undefined) return rendition.playlistUrl;
  // A bare media-playlist source: the rendition has no playlist of its own
  // and the manifest itself is reloaded as the target.
  return target !== null && target.renditionId === renditionId ? target.url : null;
}

/** Every rendition whose playlist is `url`. */
function renditionIdsAt(presentation: Presentation, url: string): readonly string[] {
  const ids: string[] = [];
  for (const period of presentation.periods) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.playlistUrl === url) ids.push(rendition.id);
      }
    }
  }
  return ids;
}

/**
 * A reload that failed, or answered with a playlist that does not parse.
 * The target tries again soon rather than let the loop die, and every
 * other playlist waits for the next tick, up to FAILURE_LIMIT times in a
 * row. Then the playlist is abandoned: its renditions are excluded, so
 * arbitration moves to another variant (or, for an audio group, to a
 * variant on another group), and the next tick reloads whatever the window
 * rendition is then. The load fails only when nothing is left to move to.
 */
function reloadFailed(
  state: HlsLiveSlice,
  kernel: Readonly<KernelState>,
  renditionId: string,
  error: MatteboxError,
): [HlsLiveSlice, Effect[]] {
  const count = (state.failures[renditionId] ?? 0) + 1;
  const failures = { ...state.failures, [renditionId]: count };
  const isTarget = state.target !== null && renditionId === state.target.renditionId;
  if (count < FAILURE_LIMIT) {
    if (!isTarget) return [{ ...state, failures }, []];
    if (state.tickPending) return [{ ...state, failures, inflight: null }, []];
    return [{ ...state, failures, inflight: null, tickPending: true }, [tick(2)]];
  }
  const presentation = kernel.presentation;
  const url =
    presentation === null ? null : playlistUrlFor(presentation, renditionId, state.target);
  const sharing =
    presentation !== null &&
    url !== null &&
    findRendition(presentation, renditionId)?.rendition.playlistUrl !== undefined
      ? renditionIdsAt(presentation, url)
      : [renditionId];
  const abandoned = [...new Set([...state.abandoned, ...sharing])];
  const messages = unavailableMessages(kernel, RELOAD_FAILED, abandoned, {
    category: 'manifest',
    code: 'MANIFEST_REFRESH_FAILED',
    fatal: true,
    recoverable: false,
    context: { cause: error.code, renditionId, attempts: count },
  });
  const next: HlsLiveSlice = {
    ...state,
    failures,
    abandoned,
    companions: state.companions.filter((c) => !abandoned.includes(c.renditionId)),
    inflight: isTarget ? null : state.inflight,
  };
  const effects = messages.map(feed);
  const failed = messages.some((m) => m.type === 'MANIFEST_FAILED');
  // The loop goes on with a new target; the tick picks it.
  if (isTarget && !failed && !state.tickPending) {
    return [{ ...next, tickPending: true }, [...effects, tick(2)]];
  }
  return [next, effects];
}

const reduceHlsLive: SliceReducer<HlsLiveSlice> = (slice, msg, kernel) => {
  const state = slice ?? INITIAL;

  if (msg.type === 'LOAD') return [{ ...INITIAL, manifestUrl: msg.url }, []];
  if (msg.type === 'UNLOAD' || msg.type === 'DETACH') return [INITIAL, []];

  if (msg.type === 'SUSPEND') {
    const effects: Effect[] = [];
    if (state.tickPending) effects.push({ kind: 'abort', token: TICK_TOKEN });
    if (state.inflight !== null) {
      effects.push({ kind: 'abort', token: refreshToken(state.inflight) });
    }
    return [{ ...state, tickPending: false, inflight: null, suspended: true }, effects];
  }

  if (msg.type === 'RESUME') {
    if (!state.suspended) return [state, []];
    const resumed = { ...state, suspended: false };
    if (state.target === null || kernel.presentation?.isLive !== true) return [resumed, []];
    // Every active playlist is stale, the ladder included: reload them all
    // now, and hold the window until the target lands so the kernel never
    // schedules against the old one. The target's answer restarts the tick.
    const effects: Effect[] = [reload(state.target)];
    for (const companion of state.companions) {
      effects.push(reload(companion));
    }
    return [{ ...resumed, inflight: state.target.renditionId, awaitingTarget: true }, effects];
  }

  // The presentation changed: the multivariant playlist landed, or a
  // playlist merged into it. Read it from the kernel, which holds every
  // merge so far.
  if (
    (msg.type === 'MANIFEST_LOADED' || msg.type === 'PLAYLIST_REFRESHED') &&
    kernel.presentation !== null
  ) {
    const presentation = kernel.presentation;
    if (!presentation.isLive) {
      return [{ ...state, target: null, companions: [], inflight: null }, []];
    }
    const rendition = windowRendition(presentation, kernel, state.abandoned);
    const effects: Effect[] = [];
    // The reload target: the rendition's own playlist when it has one, the
    // manifest itself for a bare media-playlist source.
    const url = rendition?.playlistUrl ?? state.manifestUrl;
    const target =
      url !== null && rendition !== null
        ? { url, renditionId: rendition.id, ladder: false }
        : state.target;
    const companions = companionTargets(kernel, rendition, state.abandoned);
    const switched =
      state.target !== null && target !== null && target.renditionId !== state.target.renditionId;
    let awaitingTarget = state.awaitingTarget;
    let inflight = state.inflight;
    if (switched && target !== null) {
      // A quality switch moved the window onto a playlist last fetched at
      // startup. Reload it now and hold the window until it lands. A reload
      // of that very rendition already in flight serves the same purpose.
      if (inflight !== target.renditionId) {
        effects.push(reload(target));
        inflight = target.renditionId;
      }
      awaitingTarget = true;
    } else if (!awaitingTarget && rendition !== null) {
      const window = windowFact(presentation, rendition, kernel);
      if (window !== null) effects.push(window);
    }
    // Only a dead loop (startup, or after ENDLIST) starts one.
    let tickPending = state.tickPending;
    if (!tickPending && inflight === null && target !== null) {
      effects.push(tick(presentation.live?.updatePeriod ?? 4));
      tickPending = true;
    }
    return [{ ...state, target, companions, tickPending, inflight, awaitingTarget }, effects];
  }

  if (msg.type === 'TICK' && msg.token === TICK_TOKEN) {
    // A tick that fired before its abort landed reloads nothing.
    if (state.suspended || state.target === null || kernel.presentation?.isLive !== true) {
      return [{ ...state, tickPending: false, inflight: null }, []];
    }
    let target: ReloadTarget | null = state.target;
    let awaitingTarget = state.awaitingTarget;
    if (state.abandoned.includes(target.renditionId)) {
      // The target was given up. Arbitration already moved off it; reload
      // the rendition playing now and hold the window until it answers.
      const rendition = windowRendition(kernel.presentation, kernel, state.abandoned);
      target =
        rendition?.playlistUrl !== undefined
          ? { url: rendition.playlistUrl, renditionId: rendition.id, ladder: false }
          : null;
      if (target === null) return [{ ...state, tickPending: false, inflight: null }, []];
      awaitingTarget = true;
    }
    const effects: Effect[] = [];
    let inflight = state.inflight;
    // One target reload at a time: a second in flight would answer twice
    // and every answer schedules the next tick, forking the loop.
    if (inflight !== target.renditionId) {
      effects.push(reload(target));
      inflight = target.renditionId;
    }
    for (const companion of state.companions) {
      if (companion.ladder && state.round % LADDER_EVERY !== 0) continue;
      effects.push(reload(companion));
    }
    // The target's answer schedules the next tick.
    return [
      { ...state, target, awaitingTarget, round: state.round + 1, tickPending: false, inflight },
      effects,
    ];
  }

  if (msg.type === 'SEGMENT_FAILED') {
    const renditionId = renditionOfToken(msg.trackId);
    if (renditionId === null) return [state, []];
    return reloadFailed(state, kernel, renditionId, msg.error);
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
      return reloadFailed(state, kernel, renditionId, media.error);
    }
    const failures = { ...state.failures };
    delete failures[renditionId];
    // Merge, never re-parse: refreshFor rebases the new window onto the
    // running timeline, which a fresh parse of a bare media playlist would
    // throw away, stalling live once the first window drains. The kernel
    // merges each fact into the presentation it holds when the fact lands,
    // so a companion and the target answering together both keep theirs.
    // Every rendition reading this playlist takes the same window.
    const sharing =
      findRendition(kernel.presentation, renditionId)?.rendition.playlistUrl === undefined
        ? [renditionId]
        : renditionIdsAt(kernel.presentation, url);
    const effects: Effect[] = [];
    for (const id of sharing) {
      const refresh = refreshFor(kernel.presentation, id, media.playlist);
      if (refresh !== null) effects.push(feed(refresh));
    }
    if (!isTarget) {
      // A companion, or the target of a moment ago: merged in, nothing
      // else. The window and the cadence belong to the target's reload.
      return [{ ...state, failures }, effects];
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
    if (!media.playlist.endlist && !tickPending && !state.suspended) {
      effects.push(tick(changed ? cadence : cadence / 2));
      tickPending = true;
    }
    return [
      {
        ...state,
        failures,
        lastEndSeq: endSeq,
        tickPending,
        inflight: null,
        awaitingTarget: false,
      },
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
