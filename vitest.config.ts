import { playwright } from '@vitest/browser-playwright';
import { defineConfig, type Plugin } from 'vitest/config';

// The Worker source the CDN build embeds; the unit tests need only the shape.
const WORKER_MODULE = 'virtual:transmux-worker';
const transmuxWorkerStub: Plugin = {
  name: 'transmux-worker-stub',
  resolveId: (id) => (id === WORKER_MODULE ? `\0${WORKER_MODULE}` : null),
  load: (id) => (id === `\0${WORKER_MODULE}` ? 'export default "";' : null),
};

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // `test:coverage` merges the node tier and the Chromium browser tier,
      // which covers the MSE core. v8 instruments Chromium only.
      exclude: ['src/types/**'],
      // The measured figures on 2026-10-16 minus two points. Raise them
      // when coverage rises; never lower them to pass.
      thresholds: { statements: 87, branches: 79, functions: 89, lines: 91 },
      // json-summary and json feed the PR coverage comment.
      reporter: ['text', 'json-summary', 'json'],
    },
    projects: [
      {
        plugins: [transmuxWorkerStub],
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/node/**/*.test.ts', 'src/**/*.test.ts'],
          typecheck: {
            enabled: true,
            include: ['test/types/**/*.test-d.ts'],
          },
        },
      },
      {
        plugins: [transmuxWorkerStub],
        test: {
          name: 'browser',
          include: ['test/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
          },
        },
      },
    ],
  },
});
