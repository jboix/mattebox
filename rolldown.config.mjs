import { dirname, resolve } from 'node:path';
import { defineConfig, rolldown } from 'rolldown';

// CDN bundles: one minified IIFE per preset behind the `mattebox` global.
// The transmux is compiled first into one self-contained function, which the
// main thread calls and the Worker starts from, so a page loads one file
// holding one copy.
const PRESETS = [
  'kernel',
  'hls',
  'hls-drm',
  'hls-ts',
  'hls-ts-drm',
  'dash',
  'dash-drm',
  'dual',
  'dual-drm',
  'dual-ts',
  'dual-ts-drm',
];

// The package's default target, the same as dist/es2015.
const TARGET = 'es2015';

const TRANSMUX_MODULE = 'virtual:transmux-module';
const NPM_SOURCE = resolve('src/containers/ts-transmux/source.ts');
const CDN_SOURCE = resolve('cdn/transmux-source.ts');

let transmuxCode;
/** The transmux and its Worker side, compiled once to a minified IIFE assigning `__transmux`. */
function compiledTransmux() {
  transmuxCode ??= (async () => {
    const build = await rolldown({
      input: 'src/containers/ts-transmux/module.ts',
      transform: { target: TARGET },
    });
    const { output } = await build.generate({ format: 'iife', name: '__transmux', minify: true });
    await build.close();
    return output[0].code;
  })();
  return transmuxCode;
}

/**
 * The transmux ships once. `virtual:transmux-module` is a function holding
 * the compiled transmux and returning it: the main thread calls it, and the
 * Worker starts from its source text, so it must reference nothing outside
 * itself, which the separate compile guarantees. The stage's `./source.js`
 * resolves to cdn/transmux-source.ts, so the npm source, whose dynamic import
 * an IIFE would inline as a second copy, never enters the bundle.
 */
const shipTransmuxOnce = {
  name: 'ship-transmux-once',
  async resolveId(id, importer) {
    if (id === TRANSMUX_MODULE) return `\0${TRANSMUX_MODULE}`;
    if (importer === undefined || !id.endsWith('/source.js')) return null;
    const target = resolve(dirname(importer), id.replace(/\.js$/, '.ts'));
    return target === NPM_SOURCE ? CDN_SOURCE : null;
  },
  async load(id) {
    if (id !== `\0${TRANSMUX_MODULE}`) return null;
    const code = await compiledTransmux();
    return `export default function transmuxModule() {\n${code}\nreturn __transmux;\n}`;
  },
};

function bundle(input, file) {
  return {
    input,
    plugins: [shipTransmuxOnce],
    output: { file, format: 'iife', name: 'mattebox', exports: 'default', minify: true },
    transform: {
      target: TARGET,
      // An IIFE has no `import.meta`; cdn/worker.ts supplies the Worker URL.
      define: { 'import.meta': '{}' },
    },
  };
}

export default defineConfig([
  bundle('cdn/full.ts', 'dist/cdn/mattebox.min.js'),
  ...PRESETS.map((name) => bundle(`cdn/${name}.ts`, `dist/cdn/mattebox.${name}.min.js`)),
]);
