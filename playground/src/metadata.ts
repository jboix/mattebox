/**
 * The Timed metadata table on the Diagnostics tab: every record
 * `engine.metadata` holds, the ones under the playhead marked. Empty when
 * the timed-metadata stage is not in the composition.
 */
import type { MetadataApi } from '../../src/stages/timed-metadata/index.js';
import type { MetadataEvent } from '../../src/types/metadata.js';
import { escapeHtml } from './html.js';

let signature = '';

/** What a record says, in one line: SCTE-35 summary, ID3 frames, attributes, or body. */
function details(event: MetadataEvent): string {
  const parts: string[] = [];
  const scte = event.scte35;
  if (scte !== undefined) {
    parts.push(`SCTE-35 command ${scte.commandType}`);
    if (scte.outOfNetwork !== undefined) parts.push(scte.outOfNetwork ? 'out' : 'in');
    if (scte.breakDuration !== undefined) parts.push(`break ${scte.breakDuration.toFixed(1)}s`);
    for (const s of scte.segmentations) {
      parts.push(`segmentation 0x${(s.typeId ?? 0).toString(16)}`);
    }
  }
  for (const frame of event.frames ?? []) {
    parts.push(
      `${frame.id}${frame.description ? ` ${frame.description}` : ''}: ${frame.value ?? `${frame.data.length} bytes`}`,
    );
  }
  for (const [key, value] of Object.entries(event.attributes)) {
    if (
      !['ID', 'CLASS', 'START-DATE', 'END-DATE', 'DURATION'].includes(key) &&
      !key.startsWith('SCTE35')
    ) {
      parts.push(`${key}=${value}`);
    }
  }
  if (parts.length === 0 && event.data !== undefined) parts.push(`${event.data.length} bytes`);
  return parts.join(' · ');
}

export function renderMetadata(host: HTMLElement, engine: unknown, time: number): void {
  if (host.offsetParent === null) return;
  const api = (engine as { metadata?: MetadataApi } | null)?.metadata ?? null;
  const events = api?.events ?? [];
  const active = new Set((api?.at(time) ?? []).map((e) => e.id));
  const next = `${api === null}|${events.map((e) => `${e.id}:${e.end}:${active.has(e.id)}`).join(',')}`;
  if (next === signature) return;
  signature = next;
  if (api === null) {
    host.innerHTML = '<p class="muted">The timed-metadata stage is not in this composition.</p>';
    return;
  }
  if (events.length === 0) {
    host.innerHTML = '<p class="muted">No timed metadata in this stream yet.</p>';
    return;
  }
  const rows = events.map((e) => {
    const end = e.end === null ? 'open' : e.end === e.start ? '' : e.end.toFixed(2);
    const weight = active.has(e.id) ? ' style="font-weight:600"' : '';
    return `<tr${weight}><td>${e.start.toFixed(2)}</td><td>${end}</td><td>${e.source}</td><td class="wrap">${escapeHtml(e.scheme || e.id)}<br><span class="muted">${escapeHtml(e.id)}</span></td><td class="wrap">${escapeHtml(details(e))}</td></tr>`;
  });
  host.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>start</th><th>end</th><th>source</th><th>scheme and id</th><th>details</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
