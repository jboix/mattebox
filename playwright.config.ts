import { defineConfig, devices } from '@playwright/test';

// Tier-4 playback E2E only — tiers 1–3 run under Vitest (see vitest.config.ts).
export default defineConfig({
  testDir: 'test/e2e',
  webServer: {
    command:
      'bash test/e2e/gen-streams.sh && rolldown -c rolldown.dist.config.mjs && rolldown -c rolldown.e2e.config.mjs && node test/e2e/server.mjs',
    url: 'http://localhost:4173/player.html',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  use: { baseURL: 'http://localhost:4173' },
  fullyParallel: true,
  // Real-time playback tests are decode-bound: parallel browsers miss
  // startup and ended deadlines instead of saving wall clock. One worker
  // keeps the 5-second startup assertion honest.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
