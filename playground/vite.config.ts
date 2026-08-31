import { defineConfig } from 'vite';

// The playground imports src/ directly so HMR works against source, and
// serves the generated E2E streams as its local corpus.
//
// `--mode pages` produces the hosted build. It has no public dir, because
// the fixtures beside the corpus are test data; the GitHub Pages workflow
// generates the corpus and copies `test/fixtures/streams` into the built
// site instead. Pass `--base` for the subpath the build is served from.
export default defineConfig(({ mode }) => ({
  publicDir: mode === 'pages' ? false : '../test/fixtures',
  server: {
    fs: { allow: ['..'] },
  },
  build: {
    // The hosted playground is lowered to the same target as the package's
    // default build, so a deployment exercises what users ship.
    target: 'es2015',
  },
}));
