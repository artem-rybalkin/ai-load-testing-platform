import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 600_000,      // 10 min — compare test creates 2 sequential k6 runs
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,            // 2 parallel Playwright workers; worker-backend must have WORKER_CONCURRENCY≥2
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3006',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
    // retries: 0 means 'on-first-retry' would never fire — capture on the
    // first (only) attempt instead so CI failures are diagnosable without
    // a local repro.
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/user.json' },
      dependencies: ['setup'],
    },
  ],
});
