/**
 * The QoE section on the Diagnostics tab: the `qoe` stage's figures as
 * tiles, and the `qoe:metrics` events of this load, newest first. Empty
 * when the stage is not in the composition.
 */
import type { QoeMetrics, QoeReason } from '../../src/stages/qoe/index.js';
import { escapeHtml } from './html.js';

interface Entry extends QoeMetrics {
  readonly at: Date;
  readonly reason: QoeReason;
}

const LIMIT = 20;

/** A tile's tone: good, a warning, or bad, from simple thresholds. */
function tone(value: number | null, warn: number, bad: number): string {
  if (value === null) return '';
  return value >= bad ? 'bad' : value >= warn ? 'wait' : 'ok';
}

function tile(label: string, value: string, className: string, hint: string): string {
  return `<div class="qoe-tile ${className}" title="${escapeHtml(hint)}"><span class="qoe-value">${value}</span><span class="qoe-label">${label}</span></div>`;
}

export function createQoePanel(host: HTMLElement) {
  const log: Entry[] = [];
  let signature = '';

  return {
    /** Starts a fresh log for a new engine. */
    attach(engine: { on(event: string, fn: (payload: unknown) => void): () => void } | null) {
      log.length = 0;
      signature = '';
      engine?.on('qoe:metrics', (payload) => {
        log.unshift({ ...(payload as QoeMetrics & { reason: QoeReason }), at: new Date() });
        if (log.length > LIMIT) log.pop();
      });
    },
    render(engine: unknown) {
      if (host.offsetParent === null) return;
      const qoe = (engine as { qoe?: QoeMetrics } | null)?.qoe;
      if (qoe === undefined) {
        if (signature !== 'none') {
          signature = 'none';
          host.innerHTML = '<p class="muted">The qoe stage is not in this composition.</p>';
        }
        return;
      }
      const next = `${qoe.startupTime}|${qoe.rebuffers}|${qoe.rebufferDuration.toFixed(1)}|${qoe.switches}|${log.length}|${log[0]?.at.getTime()}`;
      if (next === signature) return;
      signature = next;
      const startup = qoe.startupTime;
      const tiles = [
        tile(
          'startup',
          startup === null ? '—' : `${startup.toFixed(2)} s`,
          tone(startup, 2, 5),
          'From the load, or the first play request if later, to the first frame playing',
        ),
        tile(
          'rebuffers',
          String(qoe.rebuffers),
          tone(qoe.rebuffers, 1, 3),
          'Times playback waited for data after startup, seeks excluded',
        ),
        tile(
          'rebuffering',
          `${qoe.rebufferDuration.toFixed(1)} s`,
          tone(qoe.rebufferDuration, 0.5, 5),
          'Seconds spent waiting for data, the current wait included',
        ),
        tile(
          'switches',
          String(qoe.switches),
          '',
          'Video quality changes after the first selection',
        ),
      ].join('');
      const rows = log
        .map(
          (entry) =>
            `<tr><td>${entry.at.toLocaleTimeString()}</td><td>${entry.reason}</td><td>${entry.startupTime === null ? '—' : `${entry.startupTime.toFixed(2)} s`}</td><td>${entry.rebuffers}</td><td>${entry.rebufferDuration.toFixed(1)} s</td><td>${entry.switches}</td></tr>`,
        )
        .join('');
      const table =
        log.length === 0
          ? '<p class="muted">No qoe:metrics event yet for this load.</p>'
          : `<div class="table-wrap"><table class="table"><thead><tr><th>time</th><th>reason</th><th>startup</th><th>rebuffers</th><th>rebuffering</th><th>switches</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      host.innerHTML = `<div class="qoe-tiles">${tiles}</div>${table}`;
    },
  };
}
