import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEnv } from "@/env";
import { hashPassword, verifyPassword } from "./password";

/**
 * 单用户模式：根据 ADMIN_EMAIL / ADMIN_PASSWORD 确保管理员账号存在。
 * - 不存在则创建；
 * - 存在但密码与环境变量不一致则更新（方便通过改 .env.local 重置密码）。
 */
export async function seedAdminUser(): Promise<void> {
  const env = getEnv();
  const db = await getDb();
  const email = env.ADMIN_EMAIL.toLowerCase();

  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!existing) {
    await db.insert(users).values({
      email,
      name: "Admin",
      passwordHash: await hashPassword(env.ADMIN_PASSWORD),
    });
    console.log(`[auth] 已创建管理员账号 ${email}`);
    return;
  }

  const same = await verifyPassword(env.ADMIN_PASSWORD, existing.passwordHash);
  if (!same) {
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(env.ADMIN_PASSWORD) })
      .where(eq(users.id, existing.id));
    console.log(`[auth] 已按环境变量更新管理员密码 ${email}`);
  }
}
