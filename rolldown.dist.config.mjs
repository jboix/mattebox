import { globSync } from 'node:fs';
import { defineConfig } from 'rolldown';

// The default artifact: every module of src/, lowered to ES2015 with the
// module structure preserved. The modern build under dist/ comes from tsc.
const entries = Object.fromEntries(
  globSync('src/**/index.ts')
    .filter((path) => !path.endsWith('.test.ts'))
    .map((path) => [path.slice('src/'.length, -'.ts'.length), path]),
);
// The Worker is loaded by URL, so it is its own entry.
entries['containers/ts-transmux/transmux.worker'] = 'src/containers/ts-transmux/transmux.worker.ts';

export default defineConfig({
  input: entries,
  output: {
    dir: 'dist/es2015',
    format: 'esm',
    preserveModules: true,
    preserveModulesRoot: 'src',
    entryFileNames: '[name].js',
    chunkFileNames: '[name].js',
  },
  transform: { target: 'es2015' },
});
