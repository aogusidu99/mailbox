import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDbHandle, type DbHandle } from "@/db";
import { folders, mailAccounts, mailOps, users } from "@/db/schema";

/**
 * 用内存 PGlite 跑真实迁移，验证 schema 与迁移文件可用。
 */
describe("db (PGlite in-memory + migrations)", () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await createDbHandle({ pgliteDataDir: null });
  });

  afterAll(async () => {
    await handle.close();
  });

  test("迁移后可插入并查询用户", async () => {
    const [user] = await handle.db
      .insert(users)
      .values({ email: "t@example.com", passwordHash: "scrypt$x" })
      .returning();
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);

    const found = await handle.db.query.users.findFirst({ where: eq(users.email, "t@example.com") });
    expect(found?.id).toBe(user.id);
    expect(found?.settings).toEqual({});
  });

  test("邮箱账号、文件夹、outbox 的外键与默认值", async () => {
    const user = await handle.db.query.users.findFirst({ where: eq(users.email, "t@example.com") });
    const [account] = await handle.db
      .insert(mailAccounts)
      .values({
        userId: user!.id,
        provider: "gmail",
        presetId: "gmail",
        email: "me@gmail.com",
        imapHost: "imap.gmail.com",
        smtpHost: "smtp.gmail.com",
        credentialsEnc: "v1.x.y.z",
      })
      .returning();
    expect(account.syncStatus).toBe("idle");
    expect(account.syncWindowDays).toBe(30);

    const [folder] = await handle.db
      .insert(folders)
      .values({ accountId: account.id, path: "INBOX", name: "INBOX", role: "inbox", highestModseq: 123n })
      .returning();
    expect(folder.highestModseq).toBe(123n);

    const [op] = await handle.db
      .insert(mailOps)
      .values({ accountId: account.id, type: "set_flags", payload: { uids: [1] }, idempotencyKey: "k1" })
      .returning();
    expect(op.status).toBe("pending");

    // 幂等键唯一
    await expect(
      handle.db
        .insert(mailOps)
        .values({ accountId: account.id, type: "set_flags", payload: {}, idempotencyKey: "k1" })
        .execute(),
    ).rejects.toThrow();

    // 级联删除
    await handle.db.delete(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(await handle.db.query.folders.findMany()).toHaveLength(0);
    expect(await handle.db.query.mailOps.findMany()).toHaveLength(0);
  });
});
