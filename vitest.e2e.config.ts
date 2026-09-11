import { resolve } from 'node:path';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, type Plugin } from 'vitest/config';
import { fixtureServer } from './test/e2e/fixture-server.js';

// Playback E2E (tier 4): the suite runs inside real Chromium, Firefox, and
// WebKit pages through Vitest browser mode. The unit and browser tiers live
// in vitest.config.ts. `pnpm run test:e2e` generates the corpus, builds the
// shipped modules, and runs this.

// The suite plays the shipped code: `../../src/...` imports resolve to their
// built twins in dist/es2015. Needs `pnpm run build:es2015`.
const SRC = resolve('src');
const SHIPPED = resolve('dist/es2015');
const shipped: Plugin = {
  name: 'shipped-modules',
  // Ahead of vite:resolve, which would otherwise answer first.
  enforce: 'pre',
  async resolveId(source, importer, options) {
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (resolved === null || !resolved.id.startsWith(`${SRC}/`)) return resolved;
    return {
      id: `${SHIPPED}/${resolved.id.slice(SRC.length + 1).replace(/\.ts$/, '.js')}`,
    };
  },
};

// One browser at a time, one file at a time: parallel decode misses
// real-time deadlines. Vitest runs every browser instance of a project
// concurrently, so each browser is its own project in its own sequence
// group; groups run one after another.
const browsers = ['chromium', 'firefox', 'webkit'] as const;

export default defineConfig({
  test: {
    projects: browsers.map((browser, index) => ({
      // Each project runs its own Vite server, so the plugins ride per project.
      plugins: [shipped, fixtureServer()],
      test: {
        name: `e2e:${browser}`,
        include: ['test/e2e/**/*.test.ts'],
        fileParallelism: false,
        sequence: { groupOrder: index + 1 },
        testTimeout: 60_000,
        hookTimeout: 30_000,
        retry: process.env.CI ? 2 : 0,
        browser: {
          enabled: true,
          headless: true,
          provider: playwright(),
          // Room for the 480 px element the harness mounts.
          viewport: { width: 800, height: 600 },
          // A screenshot of a test pattern says nothing about a missed deadline.
          screenshotFailures: false,
          instances: [{ browser }],
        },
      },
    })),
  },
});
