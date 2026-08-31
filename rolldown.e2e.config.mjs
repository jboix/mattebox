import { resolve } from 'node:path';
import { defineConfig } from 'rolldown';

// The E2E page bundle: the engine plus every stage the app composes, taken
// from dist/es2015, the artifact the package ships, so the playback suite
// exercises the lowered code that reaches users and not the sources. The
// app imports `../../src/...` for the types; the resolver below swaps each
// of those for its built twin. The ts-transmux Worker is its own entry so
// the browser E2E exercises the real Worker path, not only the main-thread
// fallback: app.js resolves `new URL('./transmux.worker.js', import.meta.url)`
// to the sibling chunk, which the server serves from .build. Build first:
// `pnpm run build:es2015`.
const SRC = resolve('src');
const SHIPPED = resolve('dist/es2015');

const shipped = {
  name: 'shipped-modules',
  async resolveId(source, importer, options) {
    const resolved = await this.resolve(source, importer, options);
    if (resolved === null || !resolved.id.startsWith(`${SRC}/`)) return resolved;
    return { id: `${SHIPPED}/${resolved.id.slice(SRC.length + 1).replace(/\.ts$/, '.js')}` };
  },
};

export default defineConfig({
  input: {
    app: 'test/e2e/app.ts',
    'transmux.worker': 'dist/es2015/containers/ts-transmux/transmux.worker.js',
  },
  plugins: [shipped],
  output: {
    dir: 'test/e2e/.build',
    format: 'esm',
    entryFileNames: '[name].js',
    chunkFileNames: '[name].js',
  },
});
