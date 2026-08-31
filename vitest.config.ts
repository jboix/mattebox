import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The DOM-boundary modules are tier-3 tested in real browsers, where
      // v8 coverage cannot instrument non-chromium engines. Coverage here
      // measures what tier 1 can reach: the pure kernel.
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
      // json-summary and json feed the PR coverage report action.
      // No thresholds: coverage is reported, not gated. The per-area
      // targets in docs/11 are aims, not build failures, by owner decision.
      reporter: ['text', 'json-summary', 'json'],
    },
    projects: [
      {
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
