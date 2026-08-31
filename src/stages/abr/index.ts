/**
 * Adaptive bitrate as a stage, not kernel. It registers one chooser
 * consulted at arbitration step 5 and one constraint source for
 * emergencies; it never mutates another source's constraints and playback
 * works identically without it, at the lowest permitted rendition.
 *
 * The chooser is a pure function of its arguments: every input comes from
 * kernel telemetry, so replaying a trace through the same composition
 * reproduces every decision. The emergency path lives in a slice reducer
 * for the same reason.
 */
import { canSwitchTo } from '../../kernel/rendition-select.js';
import type { Rendition } from '../../types/ir.js';
import type { KernelState, SliceReducer } from '../../types/kernel.js';
import type { Effect, Message } from '../../types/messages.js';
import type { AbrTelemetry } from '../../types/quality.js';
import type { Stage } from '../../types/stage.js';

export interface AbrOptions {
  /** Fraction of the estimate a rendition may consume. */
  readonly safetyFactor?: number;
  /** Forward buffer required before switching up, in seconds. */
  readonly upBufferSeconds?: number;
  /** Forward buffer below which any sustainable down-switch happens immediately, in seconds. */
  readonly downBufferSeconds?: number;
  /** Fast-estimate fraction of the active bitrate that triggers the emergency floor. */
  readonly emergencyFactor?: number;
  /** Fast-estimate multiple of the emergency cap that releases it. */
  readonly recoveryFactor?: number;
}

const DEFAULTS: Required<AbrOptions> = {
  safetyFactor: 0.7,
  upBufferSeconds: 8,
  downBufferSeconds: 4,
  emergencyFactor: 0.5,
  recoveryFactor: 2,
};

/** The conservative estimate: the minimum of the slow and fast EWMAs. */
function estimateBps(telemetry: AbrTelemetry): number {
  const slow = telemetry.throughputEwma;
  const fast = telemetry.throughputFastEwma ?? slow;
  if (slow === 0) return fast;
  if (fast === 0) return slow;
  return Math.min(slow, fast);
}

function choose(
  allowed: readonly Rendition[],
  telemetry: AbrTelemetry,
  options: Required<AbrOptions>,
): string {
  const sorted = [...allowed].sort((a, b) => a.bitrate - b.bitrate);
  const lowestRendition = sorted[0] as Rendition;
  const current = allowed.find((r) => r.id === telemetry.current) ?? null;
  const estimate = estimateBps(telemetry);
  if (estimate === 0) return (current ?? lowestRendition).id;

  // The highest rendition the estimate sustains with headroom.
  let best = lowestRendition;
  for (const candidate of sorted) {
    if (candidate.bitrate <= estimate * options.safetyFactor) best = candidate;
  }
  if (current === null) return best.id;
  if (best.id === current.id) return current.id;

  const buffer = telemetry.bufferAhead ?? 0;
  // The switch policy in force: codec-switch's when loaded, the kernel
  // default otherwise. abr imports neither codec-switch nor knows which.
  const policy = telemetry.canSwitchTo ?? canSwitchTo;
  if (best.bitrate > current.bitrate) {
    // Up only on a comfortable buffer, and never through a reloading switch.
    if (buffer < options.upBufferSeconds) return current.id;
    if (policy(current, best) === 'reload') return current.id;
    return best.id;
  }
  // Down: aggressive on a thin buffer; on a healthy one only when the
  // current rendition is genuinely unsustainable.
  if (buffer < options.downBufferSeconds || current.bitrate > estimate) {
    if (policy(current, best) === 'reload') return current.id;
    return best.id;
  }
  return current.id;
}

interface AbrSlice {
  /** The emergency cap in force, or null. */
  readonly emergencyCap: number | null;
}

const INITIAL: AbrSlice = { emergencyCap: null };

/** Loops a command back into the bus through a zero-delay schedule effect. */
function feed(message: Message): Effect {
  // biome-ignore lint/suspicious/noThenProperty: `then` is the schedule effect's field name from the message taxonomy
  return { kind: 'schedule', token: 'abr:emergency', delayMs: 0, then: message };
}

function activeBitrate(kernel: Readonly<KernelState>): number | null {
  if (kernel.presentation === null || kernel.quality.active === null) return null;
  for (const period of kernel.presentation.periods) {
    for (const track of period.tracks) {
      for (const rendition of track.renditions) {
        if (rendition.id === kernel.quality.active) return rendition.bitrate;
      }
    }
  }
  return null;
}

/** The track ABR steers: video where there is one, else audio. */
function leadTrack(kernel: Readonly<KernelState>): string | undefined {
  return kernel.tracks.active.get('video') ?? kernel.tracks.active.get('audio');
}

function lowestBitrate(kernel: Readonly<KernelState>): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (const period of kernel.presentation?.periods ?? []) {
    for (const track of period.tracks) {
      if (track.contentType !== 'video') continue;
      for (const rendition of track.renditions) {
        lowest = Math.min(lowest, rendition.bitrate);
      }
    }
  }
  return Number.isFinite(lowest) ? lowest : 0;
}

/** Samples smaller than this are jitter-dominated; ignore them for emergencies. */
const MIN_SAMPLE_BYTES = 10_000;

function createEmergencyReducer(options: Required<AbrOptions>): SliceReducer<AbrSlice> {
  return (slice, msg, kernel) => {
    const state = slice ?? INITIAL;
    if (msg.type === 'UNLOAD' || msg.type === 'DETACH') return [INITIAL, []];
    // Sample-driven only: a collapse shows up in the samples, not the clock.
    // The trigger is the raw sample, not the average: waiting for an EWMA to
    // catch up means waiting several slow segments, which is exactly the
    // stall the emergency exists to prevent. A one-off spike self-heals
    // because release watches the fast average.
    //
    // Only a media segment of the active rendition's own track is a sample.
    // A playlist reload, an init segment, or an audio segment beside a video
    // rendition is a small transfer whose time is latency, not bandwidth:
    // counted, a 50 KB playlist that takes 120 ms reads as a collapse to
    // 3 Mbps under a 7 Mbps rendition, and the cap flaps on every reload.
    let raw: number | null = null;
    if (msg.type === 'THROUGHPUT_SAMPLE') {
      raw = msg.bps;
    } else if (
      msg.type === 'SEGMENT_LOADED' &&
      msg.seq >= 0 &&
      msg.trackId === leadTrack(kernel) &&
      msg.rtt > 0 &&
      msg.size >= MIN_SAMPLE_BYTES
    ) {
      raw = (msg.size * 8000) / msg.rtt;
    }
    if (raw === null) return [state, []];

    if (state.emergencyCap === null) {
      const bitrate = activeBitrate(kernel);
      if (bitrate === null || bitrate === 0) return [state, []];
      if (raw >= bitrate * options.emergencyFactor) return [state, []];
      // Collapse: floor the selection at what the network still carries,
      // as this stage's own source so nobody else's constraint is touched.
      const cap = Math.max(raw, lowestBitrate(kernel));
      return [
        { emergencyCap: cap },
        [
          feed({
            type: 'CONSTRAIN',
            source: 'abr-emergency',
            constraint: { maxBitrate: cap },
          }),
        ],
      ];
    }

    if (kernel.stats.throughputFastEwma >= state.emergencyCap * options.recoveryFactor) {
      return [INITIAL, [feed({ type: 'RELEASE_CONSTRAINT', source: 'abr-emergency' })]];
    }
    return [state, []];
  };
}

/** The stage factory. One chooser, one emergency constraint source. */
export default function abr(options?: AbrOptions): Stage {
  const resolved = { ...DEFAULTS, ...options };
  return {
    name: 'abr',
    provides: ['abr'],
    requires: ['scheduler', 'track-registry'],
    install(ctx) {
      ctx.registerChooser({
        choose: (allowed, telemetry) => choose(allowed, telemetry, resolved),
      });
      ctx.reduce('abr', createEmergencyReducer(resolved) as SliceReducer);
    },
  };
}
