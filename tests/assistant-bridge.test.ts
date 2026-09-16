import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.APP_MASTER_KEY = "d".repeat(64);
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "password123";

import { createDbHandle, setDbHandleForTests, type DbHandle } from "@/db";
import { folders, mailAccounts, mailOps, messages, users } from "@/db/schema";
import { stopBossForTests } from "@/server/jobs/boss";
import { tagForAssistant } from "@/server/mail/ops";
import { encryptCredentials } from "@/server/providers/factory";

/**
 * 「转给助手」邮件桥：Gmail 账号打 `Assistant` 标签、其它 IMAP 账号 COPY 到「Assistant」文件夹。
 */
describe("转给助手邮件桥", () => {
  let handle: DbHandle;
  let userId = "";

  async function seedAccount(provider: "gmail" | "imap", presetId: string, email: string): Promise<{ accountId: string; messageId: string }> {
    const [account] = await handle.db
      .insert(mailAccounts)
      .values({ userId, provider, presetId, email, imapHost: "h", smtpHost: "h", credentialsEnc: encryptCredentials({ password: "x" }) })
      .returning();
    const [inbox] = await handle.db.insert(folders).values({ accountId: account.id, path: "INBOX", name: "INBOX", role: "inbox" }).returning();
    const [msg] = await handle.db.insert(messages).values({ accountId: account.id, folderId: inbox.id, uid: 42, subject: "hi", date: new Date() }).returning();
    return { accountId: account.id, messageId: msg.id };
  }

  beforeAll(async () => {
    handle = await createDbHandle({ pgliteDataDir: null });
    setDbHandleForTests(handle);
    const [user] = await handle.db.insert(users).values({ email: "b@example.com", passwordHash: "x" }).returning();
    userId = user.id;
  });

  afterAll(async () => {
    await stopBossForTests();
    setDbHandleForTests(undefined);
    await handle.close();
  });

  test("Gmail 账号：打 Assistant 标签（set_labels）", async () => {
    const { accountId, messageId } = await seedAccount("gmail", "gmail", "me@gmail.com");
    const r = await tagForAssistant(userId, [messageId]);
    expect(r.tagged).toBe(1);
    const ops = await handle.db.query.mailOps.findMany({ where: eq(mailOps.accountId, accountId) });
    const op = ops.map((o) => (o.payload as { op: { type: string; add?: string[]; toFolder?: string } }).op).find((o) => o.type === "set_labels");
    expect(op).toBeTruthy();
    expect(op?.add).toContain("Assistant");
  });

  test("IMAP 账号：创建 Assistant 文件夹并 COPY（create_folder + copy）", async () => {
    const { accountId, messageId } = await seedAccount("imap", "custom", "me@qq.com");
    const r = await tagForAssistant(userId, [messageId]);
    expect(r.tagged).toBe(1);
    const ops = await handle.db.query.mailOps.findMany({ where: eq(mailOps.accountId, accountId) });
    const types = ops.map((o) => (o.payload as { op: { type: string; toFolder?: string } }).op);
    const create = types.find((o) => o.type === "create_folder");
    const copy = types.find((o) => o.type === "copy");
    expect(create).toBeTruthy();
    expect(copy).toBeTruthy();
    expect(copy?.toFolder).toBe("Assistant");
  });
});
