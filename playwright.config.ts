import { defineConfig, devices } from '@playwright/test';

// Playback E2E. The unit and browser tiers run under Vitest.
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
  // One worker: parallel browsers miss real-time deadlines.
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
