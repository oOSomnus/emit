import { defineConfig } from "@playwright/test";

const desktopViewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.spec.ts",
  outputDir: "./test-results/browser/artifacts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["junit", { outputFile: "test-results/browser/junit.xml" }],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { browserName: "chromium", viewport: desktopViewport },
    },
    {
      name: "chromium-mobile",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "firefox-desktop",
      use: { browserName: "firefox", viewport: desktopViewport },
    },
    {
      name: "webkit-desktop",
      use: { browserName: "webkit", viewport: desktopViewport },
    },
  ],
});
