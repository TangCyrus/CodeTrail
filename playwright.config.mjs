import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser", fullyParallel: false, workers: 1, timeout: 30_000,
  expect: { timeout: 10_000 }, reporter: "list", outputDir: "artifacts/browser-test-results",
  use: { channel: process.env.CODEGRAPH_BROWSER_CHANNEL ?? "chrome", headless: true, viewport: { width: 1440, height: 900 }, locale: "zh-CN", trace: "retain-on-failure", screenshot: "only-on-failure" },
});
