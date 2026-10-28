/**
 * The Breaks table on the Diagnostics tab: every break `engine.interstitials`
 * holds, the one that plays marked. Empty when the interstitials stage is
 * not in the composition.
 */
import type { Break, InterstitialsApi } from '../../src/stages/interstitials/index.js';
import { escapeHtml } from './html.js';

let signature = '';

/** What a break does, in one line. */
function rules(entry: Break): string {
  const parts: string[] = [];
  if (entry.cue !== undefined) parts.push(entry.cue === 'pre' ? 'pre-roll' : 'post-roll');
  parts.push(entry.covers > 0 ? `replaces ${entry.covers.toFixed(1)} s` : 'inserts');
  parts.push(`resumes +${entry.resumeOffset.toFixed(1)} s`);
  if (entry.once) parts.push('once');
  if (entry.noSkip) parts.push('no skip');
  if (entry.noJump) parts.push('no jump');
  if (entry.playoutLimit !== undefined) parts.push(`limit ${entry.playoutLimit.toFixed(1)} s`);
  if (entry.assets.length === 0 && entry.assetList === undefined) parts.push('plays the stream');
  return parts.join(' · ');
}

export function renderInterstitials(host: HTMLElement, engine: unknown): void {
  if (host.offsetParent === null) return;
  const api = (engine as { interstitials?: InterstitialsApi } | null)?.interstitials ?? null;
  const breaks = api?.breaks ?? [];
  const playing = api?.playing ?? null;
  const next = `${api === null}|${playing?.break.id}:${playing?.asset}|${breaks.map((b) => `${b.id}:${b.assets.length}`).join(',')}`;
  if (next === signature) return;
  signature = next;
  if (api === null) {
    host.innerHTML = '<p class="muted">The interstitials stage is not in this composition.</p>';
    return;
  }
  if (breaks.length === 0) {
    host.innerHTML = '<p class="muted">No breaks in this stream.</p>';
    return;
  }
  const rows = breaks.map((b) => {
    const weight = playing?.break.id === b.id ? ' style="font-weight:600"' : '';
    const assets =
      b.assets.length > 0
        ? b.assets.map((a) => escapeHtml(a.url)).join('<br>')
        : escapeHtml(b.assetList ?? '');
    return `<tr${weight}><td>${b.start.toFixed(2)}</td><td>${b.source}</td><td class="wrap">${escapeHtml(b.id)}</td><td class="wrap">${escapeHtml(rules(b))}</td><td class="wrap">${assets}</td></tr>`;
  });
  host.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>start</th><th>source</th><th>id</th><th>rules</th><th>assets</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
