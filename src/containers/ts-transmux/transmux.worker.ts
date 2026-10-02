/**
 * The Worker entry of the npm build, loaded by URL. Everything it does is
 * in serve.ts, which the script-tag bundle also starts from its one copy of
 * the transmux.
 */
import { serveTransmux, type TransmuxScope } from './serve.js';

serveTransmux(self as unknown as TransmuxScope);
