import { expect, test } from "@playwright/test";
import { FAKE_IMAP_PORT, FAKE_PASS, FAKE_SMTP_PORT, FAKE_USER, startFakeMailServers, type FakeMailServers } from "./fake-mail-server";
import { startFakeOpenAIServer } from "./fake-openai-server";
import { addFakeAccount, login, removeAccountIfExists, waitForInbox } from "./helpers";

/**
 * M3 验收：在 AI 设置页添加自定义（假）厂商 → 保存 Key → 刷新模型 → 设为默认 → 测试连接；
 * 回到收件箱对一封邮件「AI 分析」并看到摘要；「AI 起草回复」生成草稿进入写信框。
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

test("配置假 AI 厂商并对邮件做分析与起草", async ({ page }) => {
  await login(page);

  await page.goto("/mail/settings/ai");
  await expect(page.getByRole("heading", { name: "AI 设置" })).toBeVisible();

  // 添加自定义厂商（幂等：已存在则直接选中）
  const existing = page.getByRole("button", { name: /Fake AI/ });
  if ((await existing.count()) === 0) {
    await page.getByText("添加 OpenAI 兼容厂商").click();
    await page.getByPlaceholder(/^id（/).fill("fake");
    await page.getByPlaceholder("名称").fill("Fake AI");
    await page.getByPlaceholder(/baseUrl/).fill(ai.baseUrl);
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect(page.getByText("已添加厂商")).toBeVisible();
  } else {
    await existing.click();
  }

  await page.getByLabel("Fake AI API Key").fill("test-key");
  await page.getByRole("button", { name: "保存 Key" }).click();
  await expect(page.getByText("已保存 API Key")).toBeVisible();

  await page.getByRole("button", { name: "刷新模型列表" }).click();
  await expect(page.getByText(/拉取到 2 个模型/)).toBeVisible();
  // 勾选两个模型进候选池（已勾选则跳过）
  for (const id of ["fake-smart", "fake-fast"]) {
    const box = page.locator("label", { hasText: id }).locator("input[type=checkbox]");
    if (!(await box.isChecked())) {
      await box.click();
      await expect(box).toBeChecked();
    }
  }
  await expect(page.getByText("候选池（2）")).toBeVisible();

  // 设为全局默认模型
  const defaultSelect = page.locator("select").filter({ hasText: /请选择|当前默认厂商|fake-smart/ }).first();
  await defaultSelect.selectOption("fake-smart");
  await expect(page.getByText("已更新默认模型")).toBeVisible();

  await page.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByText(/回复：ok/)).toBeVisible();

  // 重新添加假邮箱并到收件箱做 AI 分析
  await removeAccountIfExists(page, FAKE_USER);
  await addFakeAccount(page, { email: FAKE_USER, password: FAKE_PASS, imapPort: FAKE_IMAP_PORT, smtpPort: FAKE_SMTP_PORT });
  const { accountId, folderId } = await waitForInbox(page, FAKE_USER);
  await page.goto(`/mail/${accountId}/${folderId}`);
  const row = page.getByRole("button", { name: /发票已开具/ });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();

  await page.getByRole("button", { name: "AI 分析" }).click();
  await expect(page.getByText("已完成 AI 分析")).toBeVisible();
  await expect(page.getByText("9 月发票已开具，请查收附件。").first()).toBeVisible();
  await expect(page.getByText("核对发票金额")).toBeVisible();

  await page.getByRole("button", { name: "AI 起草回复" }).click();
  await page.getByRole("button", { name: "生成草稿" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "回复" });
  await expect(dialog.getByLabel("正文")).toHaveValue(/发票已收到/);
  await page.screenshot({ path: "test-results/m3-ai-draft.png" });
});
