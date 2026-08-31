import { globSync } from 'node:fs';
import { defineConfig } from 'rolldown';

// The package's default artifact: every module of src/, lowered to ES2015
// syntax with the module structure preserved, so a consumer's bundler still
// tree-shakes it. One helper module per lowered feature lands under
// dist/es2015/_virtual and is imported, never inlined per file. The floor is
// the oldest MSE-capable estate that still matters: Chrome 49, Safari 10,
// Firefox 45, Edge 13, and the TV platforms built on them. Syntax only:
// Promise, Map, fetch, TextDecoder, and WebCrypto are assumed, since every
// browser with MSE has them.
//
// The modern build (dist/, tsc, ES2022 as written) stays behind the `modern`
// export condition for apps that target evergreen browsers.
const entries = Object.fromEntries(
  globSync('src/**/index.ts')
    .filter((path) => !path.endsWith('.test.ts'))
    .map((path) => [path.slice('src/'.length, -'.ts'.length), path]),
);
// The transmux Worker is reached by URL, not by import, so it is its own entry
// at the path the runner resolves next to itself.
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
