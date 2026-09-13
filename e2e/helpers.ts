import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

/** 从 .env.local 读取管理员账号（不会打印到日志）。 */
export function readAdminCredentials(): { email: string; password: string } {
  const file = path.resolve(process.cwd(), ".env.local");
  const text = readFileSync(file, "utf8");
  const get = (key: string) => {
    const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim() : "";
  };
  const email = process.env.ADMIN_EMAIL || get("ADMIN_EMAIL");
  const password = process.env.ADMIN_PASSWORD || get("ADMIN_PASSWORD");
  if (!email || !password) throw new Error("缺少 ADMIN_EMAIL / ADMIN_PASSWORD，请先运行 bun run setup");
  return { email, password };
}

export async function login(page: Page): Promise<void> {
  const creds = readAdminCredentials();
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(creds.email);
  await page.getByLabel("密码").fill(creds.password);
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/mail/);
}

interface SidebarJson {
  accounts: Array<{ id: string; email: string; folders: Array<{ id: string; role: string }> }>;
}

export async function findAccount(page: Page, email: string) {
  const res = await page.request.get("/api/mail/sidebar");
  const data = (await res.json()) as SidebarJson;
  return data.accounts.find((a) => a.email === email) ?? null;
}

/** 假邮件服务器每次重启都是初始状态，为保证用例可重复运行，先移除本地缓存的假账号。 */
export async function removeAccountIfExists(page: Page, email: string): Promise<void> {
  if (!(await findAccount(page, email))) return;
  await page.goto("/mail/accounts");
  const row = page.locator("div", { hasText: email }).filter({ has: page.getByRole("button", { name: /移除/ }) }).last();
  await row.getByRole("button", { name: /移除/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "移除" }).click();
  await page.waitForFunction(async (target) => {
    const r = await fetch("/api/mail/sidebar");
    const d = (await r.json()) as SidebarJson;
    return !d.accounts.some((a) => a.email === target);
  }, email);
}

/** 通过向导添加假 IMAP 账号（自定义服务器，无 TLS）。 */
export async function addFakeAccount(page: Page, opts: { email: string; password: string; imapPort: number; smtpPort: number }): Promise<void> {
  await page.goto("/mail/accounts/new");
  await page.getByLabel("邮箱地址").fill(opts.email);
  await page.getByLabel("邮箱服务商").selectOption("custom");
  await page.getByLabel("授权码 / 应用专用密码").fill(opts.password);
  await page.getByLabel("IMAP 主机").fill("127.0.0.1");
  await page.getByLabel("IMAP 端口").fill(String(opts.imapPort));
  await page.getByLabel("IMAP TLS").selectOption("0");
  await page.getByLabel("SMTP 主机").fill("127.0.0.1");
  await page.getByLabel("SMTP 端口").fill(String(opts.smtpPort));
  await page.getByLabel("SMTP TLS").selectOption("0");
  await page.getByRole("button", { name: "保存并开始同步" }).click();
  await page.waitForURL(/\/mail(\/|$)/);
}

/** 等到账号的收件箱出现并返回其路径 */
export async function waitForInbox(page: Page, email: string): Promise<{ accountId: string; folderId: string }> {
  for (let i = 0; i < 60; i++) {
    const account = await findAccount(page, email);
    const inbox = account?.folders.find((f) => f.role === "inbox");
    if (account && inbox) return { accountId: account.id, folderId: inbox.id };
    await page.waitForTimeout(1000);
  }
  throw new Error("收件箱一直没有出现");
}
