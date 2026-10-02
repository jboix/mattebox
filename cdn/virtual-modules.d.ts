/**
 * The transmux compiled once into a self-contained function by
 * rolldown.config.mjs: it references nothing outside itself, so its source
 * text also starts a Worker.
 */
declare module 'virtual:transmux-module' {
  const transmuxModule: () => typeof import('../src/containers/ts-transmux/module.js');
  export default transmuxModule;
}
