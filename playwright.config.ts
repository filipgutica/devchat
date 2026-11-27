import { defineConfig, devices } from '@playwright/test'

// The UI tests (test/ui) run the built shell (`pnpm build`) against a real local board; each test
// starts its own host through scripts/ui-host.ts.
export default defineConfig({
  testDir: 'test/ui',
  outputDir: 'test-results',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
