import { expect, test } from "@playwright/test";
import { FAKE_USER, startFakeMailServers, type FakeMailServers } from "./fake-mail-server";
import { login } from "./helpers";

/**
 * M2 验收：回复并通过 SMTP 发送、星标、归档。
 * 前置：m1 用例已把假邮箱添加进应用（本文件在 m1 之后运行）。
 */

let servers: FakeMailServers;

test.beforeAll(async () => {
  servers = await startFakeMailServers();
});

test.afterAll(async () => {
  await servers.close();
});

test("回复邮件通过 SMTP 发出，星标与归档同步", async ({ page }) => {
  await login(page);
  const sidebar = await page.request.get("/api/mail/sidebar");
  const data = (await sidebar.json()) as { accounts: Array<{ id: string; email: string; folders: Array<{ id: string; role: string }> }> };
  const account = data.accounts.find((a) => a.email === FAKE_USER);
  test.skip(!account, "需要先运行 m1 用例添加假邮箱");
  const inbox = account!.folders.find((f) => f.role === "inbox")!;
  await page.goto(`/mail/${account!.id}/${inbox.id}`);

  // 触发一次同步，确保假服务器重启后状态一致
  await page.getByRole("button", { name: "刷新" }).click();

  const row = page.getByRole("button", { name: /项目周报/ });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  await expect(page.getByRole("heading", { name: "项目周报：本周进展" })).toBeVisible();

  // 回复
  await page.getByRole("button", { name: "回复", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("收件人")).toHaveValue(/alice@example\.com/);
  await expect(dialog.getByLabel("主题")).toHaveValue("Re: 项目周报：本周进展");
  await dialog.getByLabel("正文").fill("收到，辛苦了！\n\n> 引用");
  await dialog.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("已发送")).toBeVisible();
  await expect.poll(() => servers.received.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(servers.received[0]).toContain("Subject: =?UTF-8?");
  expect(servers.received[0]).toContain("In-Reply-To: <e1@example.com>");

  // 星标
  await page.getByRole("button", { name: "加星标" }).click();
  await expect(page.getByRole("button", { name: "取消星标" })).toBeVisible();

  // 归档：从列表消失
  await page.getByRole("button", { name: "归档" }).click();
  await expect(page.getByText("已归档")).toBeVisible();
  await expect(page.getByRole("button", { name: /项目周报/ })).toHaveCount(0);
  await page.screenshot({ path: "test-results/m2-after-archive.png" });
});
