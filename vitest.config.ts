import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Per-area line coverage targets; the kernel is near-total because tier 1 is cheap.
      thresholds: {
        'src/kernel/**': { lines: 95 },
        'src/protocols/**': { lines: 90 },
        'src/containers/**': { lines: 85 },
        'src/stages/**': { lines: 80 },
      },
    },
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/node/**/*.test.ts', 'src/**/*.test.ts'],
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
