/**
 * Quality of experience, measured locally: startup time, rebuffering, and
 * quality switches, for the integrator's own analytics. Nothing leaves the
 * page. The definitions follow common practice (CTA-2066 terms):
 *
 * - Startup time: from the later of the load and the first play request to
 *   the first `playing` event of that load.
 * - Rebuffering: playback waiting for data after startup, not while
 *   seeking. It starts on the element's `waiting` or the engine's
 *   `playback:stalled`, and ends when time moves again.
 * - Switches: video rendition changes after the first selection.
 *
 * `engine.qoe` reads the current figures. `qoe:metrics` carries them, with
 * the reason, each time one changes. A new load starts them over.
 */
import type { Stage } from '../../types/stage.js';

export interface QoeMetrics {
  /** Seconds from load (or play, if later) to the first frame playing; null before it. */
  readonly startupTime: number | null;
  readonly rebuffers: number;
  /** Seconds spent rebuffering, the current one included. */
  readonly rebufferDuration: number;
  readonly switches: number;
}

export type QoeReason = 'startup' | 'rebuffer' | 'switch';

declare module '../../index.js' {
  interface MatteboxNamespaces {
    qoe: QoeMetrics;
  }
}

export default function qoe(): Stage {
  return {
    name: 'qoe',
    provides: ['qoe'],
    install(ctx) {
      const element = ctx.element;
      let loadedAt: number | null = null;
      let playAt: number | null = null;
      let startupTime: number | null = null;
      let rebuffers = 0;
      let finished = 0;
      let stallFrom: number | null = null;
      let stallTime = 0;
      let switches = 0;
      let rendition: string | null = null;

      const now = (): number => performance.now() / 1000;
      const metrics = (): QoeMetrics => ({
        startupTime,
        rebuffers,
        rebufferDuration: finished + (stallFrom === null ? 0 : now() - stallFrom),
        switches,
      });
      const report = (reason: QoeReason): void => {
        ctx.emit('qoe:metrics', { ...metrics(), reason });
      };

      function reset(): void {
        loadedAt = now();
        playAt = element.paused ? null : loadedAt;
        startupTime = null;
        rebuffers = 0;
        finished = 0;
        stallFrom = null;
        switches = 0;
        rendition = null;
      }

      function stall(): void {
        if (startupTime === null || stallFrom !== null || element.seeking || element.paused) return;
        stallFrom = now();
        stallTime = element.currentTime;
        rebuffers += 1;
      }

      function resume(): void {
        if (stallFrom === null) return;
        finished += now() - stallFrom;
        stallFrom = null;
        report('rebuffer');
      }

      const onPlay = (): void => {
        if (playAt === null && loadedAt !== null) playAt = now();
      };
      const onPlaying = (): void => {
        if (startupTime === null && loadedAt !== null) {
          startupTime = now() - Math.max(loadedAt, playAt ?? loadedAt);
          report('startup');
          return;
        }
        resume();
      };
      const onTime = (): void => {
        // A stall the browser never announced ends when time moves on.
        if (stallFrom !== null && element.currentTime > stallTime + 0.1) resume();
      };
      const onSeeking = (): void => {
        // A seek is not rebuffering: whatever was waiting ends here.
        resume();
      };
      element.addEventListener('play', onPlay);
      element.addEventListener('playing', onPlaying);
      element.addEventListener('waiting', stall);
      element.addEventListener('timeupdate', onTime);
      element.addEventListener('seeking', onSeeking);
      const offStalled = ctx.on('playback:stalled', stall);
      // Loads and switches show in the message trace, which every stage may read.
      const offTrace = ctx.on('trace', (entry) => {
        if ((entry as { msg: { type: string } }).msg.type === 'LOAD') reset();
        const active = ctx.getState().quality.active;
        if (active === rendition) return;
        if (rendition !== null && active !== null) {
          switches += 1;
          report('switch');
        }
        rendition = active;
      });

      ctx.registerNamespace('qoe', {
        get startupTime() {
          return startupTime;
        },
        get rebuffers() {
          return rebuffers;
        },
        get rebufferDuration() {
          return metrics().rebufferDuration;
        },
        get switches() {
          return switches;
        },
      } satisfies QoeMetrics);

      return () => {
        element.removeEventListener('play', onPlay);
        element.removeEventListener('playing', onPlaying);
        element.removeEventListener('waiting', stall);
        element.removeEventListener('timeupdate', onTime);
        element.removeEventListener('seeking', onSeeking);
        offStalled();
        offTrace();
      };
    },
  };
}
