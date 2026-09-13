import { expect, test } from "@playwright/test";
import { FAKE_IMAP_PORT, FAKE_PASS, FAKE_SMTP_PORT, FAKE_USER, startFakeMailServers, type FakeMailServers } from "./fake-mail-server";
import { startFakeOpenAIServer } from "./fake-openai-server";
import { addFakeAccount, login, removeAccountIfExists, waitForInbox } from "./helpers";

/**
 * M4 验收：自然语言规则（编译 → 预览 → 保存 → 立即执行）、和邮箱对话（工具检索 + 回答）、待办页。
 * 前置：m3 用例已配置好假 AI 厂商（fake / test-key / 默认 fake-smart）。
 */

let mail: FakeMailServers;
let ai: Awaited<ReturnType<typeof startFakeOpenAIServer>>;

test.beforeAll(async () => {
  mail = await startFakeMailServers();
  ai = await startFakeOpenAIServer();
});

test.afterAll(async () => {
  await ai.close();
  await mail.close();
});

test("规则、对话与待办", async ({ page }) => {
  await login(page);
  await removeAccountIfExists(page, FAKE_USER);
  await addFakeAccount(page, { email: FAKE_USER, password: FAKE_PASS, imapPort: FAKE_IMAP_PORT, smtpPort: FAKE_SMTP_PORT });
  const { accountId, folderId } = await waitForInbox(page, FAKE_USER);

  // 等待正文同步完成（列表出现摘要）
  await page.goto(`/mail/${accountId}/${folderId}`);
  await expect(page.getByRole("button", { name: /发票已开具/ })).toBeVisible({ timeout: 60_000 });

  // 规则：先清掉上次运行留下的同名规则，再 编译 → 预览命中 → 保存 → 立即执行
  await page.goto("/mail/settings/rules");
  for (let i = 0; i < 10; i++) {
    const del = page.getByRole("button", { name: "删除规则 发票加星标" });
    if ((await del.count()) === 0) break;
    await del.first().click();
    await expect(page.getByText("已删除").first()).toBeVisible();
    await page.waitForTimeout(300);
  }
  await page.getByLabel("规则描述").fill("主题包含发票的邮件加星标");
  await page.getByRole("button", { name: "用 AI 编译并预览" }).click();
  await expect(page.getByText("发票加星标").first()).toBeVisible();
  await expect(page.getByText(/命中 1 封/)).toBeVisible();
  await page.getByRole("button", { name: "保存规则" }).click();
  await expect(page.getByText("规则已保存")).toBeVisible();
  await expect(page.getByText("已有规则（1）")).toBeVisible();
  await page.getByRole("button", { name: "立即执行" }).first().click();
  await expect(page.getByText(/已对 1 封邮件执行/)).toBeVisible();

  // 收件箱里该邮件已加星标（本地乐观更新）
  await page.goto(`/mail/${accountId}/${folderId}`);
  await page.getByRole("button", { name: /发票已开具/ }).click();
  await expect(page.getByRole("button", { name: "取消星标" })).toBeVisible();

  // 对话：假 AI 先调用 search_mail 再回答
  await page.goto("/mail/chat");
  await page.getByLabel("向助理提问").fill("帮我找发票");
  await page.getByLabel("向助理提问").press("Enter");
  await expect(page.getByText(/找到 1 封关于发票的邮件/)).toBeVisible({ timeout: 30_000 });
  await page.getByText(/查看检索过程/).click();
  await expect(page.getByText(/search_mail：搜索「发票」：1 条/)).toBeVisible();

  // 待办页：m3 的 AI 分析产生了「核对发票金额」
  await page.goto(`/mail/${accountId}/${folderId}`);
  await page.getByRole("button", { name: /发票已开具/ }).click();
  await page.getByRole("button", { name: "AI 分析" }).click();
  await expect(page.getByText("已完成 AI 分析")).toBeVisible();
  await page.goto("/mail/todos");
  await expect(page.getByText("核对发票金额")).toBeVisible();
  await page.getByLabel("完成：核对发票金额").click();
  await expect(page.getByLabel("完成：核对发票金额")).toBeChecked();
  // 刷新后状态来自数据库
  await page.reload();
  await expect(page.getByLabel("完成：核对发票金额")).toBeChecked();
  await page.screenshot({ path: "test-results/m4-todos.png" });
});
