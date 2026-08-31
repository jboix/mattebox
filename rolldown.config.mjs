import { defineConfig } from 'rolldown';

// CDN convenience bundles only; the primary artifact is the unbundled ESM in
// dist/. One bundle per preset, each a single callable global (see
// cdn/global.ts). `mattebox.min.js` is the full preset and keeps its path;
// the lighter presets sit beside it as `mattebox.<preset>.min.js`. The
// ts-transmux Worker is built once as a sibling file with the name
// cdn/worker.ts resolves relative to the script URL, so a page that loads a
// -ts bundle and the Worker from the same directory needs no configuration.
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

// One target, the package default: ES2015 syntax, the same floor and the
// same lowering as dist/es2015 (see rolldown.dist.config.mjs).
const TARGET = 'es2015';

function bundle(input, file) {
  return {
    input,
    output: { file, format: 'iife', name: 'mattebox', exports: 'default', minify: true },
    transform: {
      target: TARGET,
      // The runner's `new URL('./transmux.worker.js', import.meta.url)`
      // branch is unreachable in a bundle: cdn/worker.ts always supplies
      // workerUrl when the script URL is known, the CMAF-only presets never
      // carry the runner, and the runner falls back to the main thread
      // otherwise. Replace `import.meta` with `{}` to keep the IIFE valid.
      define: { 'import.meta': '{}' },
    },
  };
}

export default defineConfig([
  bundle('cdn/full.ts', 'dist/cdn/mattebox.min.js'),
  ...PRESETS.map((name) => bundle(`cdn/${name}.ts`, `dist/cdn/mattebox.${name}.min.js`)),
  {
    input: 'src/containers/ts-transmux/transmux.worker.ts',
    output: { file: 'dist/cdn/transmux.worker.js', format: 'iife', minify: true },
    transform: { target: TARGET },
  },
]);
