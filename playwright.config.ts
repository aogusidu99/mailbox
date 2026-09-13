import { defineConfig } from "@playwright/test";

/**
 * 端到端测试：驱动本机已安装的 Edge（无需下载浏览器），访问正在运行的开发服务器。
 * 运行：bun run dev（另一个终端）→ bun run e2e
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    channel: "msedge",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    locale: "zh-CN",
  },
});
