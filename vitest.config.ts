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
      // v8 cannot instrument Firefox or WebKit; coverage measures the node tier.
      exclude: [
        'src/kernel/mse.ts',
        'src/kernel/append-queue.ts',
        'src/kernel/evictor.ts',
        'src/kernel/lifecycle.ts',
        'src/kernel/sinks/text-track-sink.ts',
        'src/kernel/sinks/metadata-sink.ts',
        'src/index.ts',
        'src/types/**',
      ],
      // json-summary and json feed the PR coverage comment. No thresholds.
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
