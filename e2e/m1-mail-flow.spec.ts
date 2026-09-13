import { expect, test } from "@playwright/test";
import { FAKE_IMAP_PORT, FAKE_PASS, FAKE_SMTP_PORT, FAKE_USER, startFakeMailServers, type FakeMailServers } from "./fake-mail-server";
import { login, removeAccountIfExists } from "./helpers";

/**
 * M1 验收：登录 → 添加邮箱（本地假 IMAP，含测试连接）→ 同步 → 列表 → 阅读正文与附件。
 */

let servers: FakeMailServers;

test.beforeAll(async () => {
  servers = await startFakeMailServers();
});

test.afterAll(async () => {
  await servers.close();
});

test("登录后添加邮箱并阅读同步下来的邮件", async ({ page }) => {
  await login(page);
  await removeAccountIfExists(page, FAKE_USER);

  await page.goto("/mail/accounts/new");
  await page.getByLabel("邮箱地址").fill(FAKE_USER);
  await page.getByLabel("邮箱服务商").selectOption("custom");
  await page.getByLabel("授权码 / 应用专用密码").fill(FAKE_PASS);
  await page.getByLabel("IMAP 主机").fill("127.0.0.1");
  await page.getByLabel("IMAP 端口").fill(String(FAKE_IMAP_PORT));
  await page.getByLabel("IMAP TLS").selectOption("0");
  await page.getByLabel("SMTP 主机").fill("127.0.0.1");
  await page.getByLabel("SMTP 端口").fill(String(FAKE_SMTP_PORT));
  await page.getByLabel("SMTP TLS").selectOption("0");

  await page.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByText(/已找到 \d+ 个文件夹/)).toBeVisible();
  await expect(page.getByText("登录成功")).toBeVisible();

  await page.getByRole("button", { name: "保存并开始同步" }).click();
  await page.waitForURL(/\/mail(\/|$)/);

  // 侧栏出现收件箱（首次同步完成后自动跳转）
  await expect(page.getByRole("link", { name: /收件箱/ }).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("link", { name: /收件箱/ }).first().click();

  // 列表里有同步下来的邮件
  const row = page.getByRole("button", { name: /发票已开具/ });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();

  // 阅读窗格：主题、正文（iframe）、附件、远程图片被屏蔽
  await expect(page.getByRole("heading", { name: "发票已开具（附件）" })).toBeVisible();
  const frame = page.frameLocator('iframe[title="邮件正文"]');
  await expect(frame.locator("b")).toHaveText("9 月");
  await expect(page.getByText("report.pdf")).toBeVisible();
  await expect(page.getByText(/已屏蔽 1 张远程图片/)).toBeVisible();

  await page.screenshot({ path: "test-results/m1-inbox.png", fullPage: false });
});
