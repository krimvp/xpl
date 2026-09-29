import { defineConfig, devices } from "@playwright/test";

// Browsers come from PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers in the sandbox, matching the
// pinned @playwright/test version). Never run `playwright install` there.
// `npm run test:e2e` builds the viewer first; the specs open the built file:// page.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
});
