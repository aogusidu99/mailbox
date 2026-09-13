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
