/**
 * The script-tag bundle's transmux source. rolldown.config.mjs compiles the
 * transmux once into a self-contained function and puts this module where
 * the npm build's source.ts would be. The main thread holds one instance of
 * that function (cdn/transmux-instance.ts); the Worker starts from its
 * source text in a blob, so the bundle carries one copy. A strict
 * `worker-src` CSP blocks the blob Worker, and the runner then uses the
 * main thread's instance, which needs no eval.
 */
import transmuxModule from 'virtual:transmux-module';
import type { TransmuxSource } from '../src/containers/ts-transmux/runner.js';
import { instance } from './transmux-instance.js';

let workerUrl: string | null = null;

export const transmuxSource: TransmuxSource = {
  load: () => Promise.resolve(instance.transmux),
  worker: () => {
    // A classic Worker: Chromium 76, the TV floor, has no module Workers.
    workerUrl ??= URL.createObjectURL(
      new Blob([`(${transmuxModule.toString()})().serveTransmux(self)`], {
        type: 'text/javascript',
      }),
    );
    return new Worker(workerUrl);
  },
};
