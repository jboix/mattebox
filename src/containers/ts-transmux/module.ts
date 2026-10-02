/**
 * Everything the transmux needs on either side of a Worker, as one module:
 * the script-tag bundle compiles it once into a self-contained function,
 * calls that on the main thread, and starts the Worker from its source.
 */
export { serveTransmux } from './serve.js';
export { transmux } from './transmux.js';
