import { defineConfig, devices } from "@playwright/test";

// Browsers come from PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers in the sandbox, matching the
// pinned @playwright/test version). Never run `playwright install` there.
// `npm run test:e2e` builds the viewer first; the global setup then builds the TS fixture bundle
// (scripts/make-bundle.ts) and the specs open that self-contained file:// page.
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // The retry keeps a trace of the first failure; a test that then passes is flaky, and fails the run: a
  // flake is a bug to find, never a pass.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  // Three times Playwright's defaults (30 s per test, 5 s per expect): a slow runner should be slow, not red.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
});
