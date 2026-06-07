import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    {
      name: 'mobile',
      use: {
        browserName: 'chromium',
        channel: 'chrome',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2
      }
    }
  ],
  webServer: [
    {
      command: 'npm run dev:server',
      url: 'http://127.0.0.1:8788/api/health',
      reuseExistingServer: true
    },
    {
      command: 'npm run dev:client',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true
    }
  ]
});
