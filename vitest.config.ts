import { configDefaults, defineConfig } from "vitest/config";

// Unit tests of every package live in packages/<pkg>/test. Playwright specs (packages/viewer/e2e)
// are run by `npm run test:e2e`, never by vitest. Fixtures under fixtures/ have their own runners.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}"],
    exclude: [...configDefaults.exclude, "**/dist/**", "**/e2e/**"],
    environment: "node",
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
