import { resolve } from 'node:path';
import { defineConfig } from 'rolldown';

// The E2E page bundle, built from dist/es2015 so the suite plays the shipped
// code: `../../src/...` imports resolve to their built twins. Needs
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
