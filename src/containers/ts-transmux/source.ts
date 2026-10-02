/**
 * The npm build's transmux source: the Worker chunk by URL, and the module
 * itself through a dynamic import, so a bundler splits it out of the main
 * graph and a page downloads it on the main thread only when the Worker
 * fails. The script-tag bundle replaces this module with its own source
 * (cdn/transmux-source.ts) and never bundles it.
 */
import type { TransmuxSource } from './runner.js';

export const transmuxSource: TransmuxSource = {
  load: () => import('./transmux.js').then((module) => module.transmux),
  worker: () => new Worker(new URL('./transmux.worker.js', import.meta.url), { type: 'module' }),
};
