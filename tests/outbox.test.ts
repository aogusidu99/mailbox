import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import hoodiecrow from "hoodiecrow-imap";
import { ImapFlow } from "imapflow";

process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.APP_MASTER_KEY = "b".repeat(64);
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "password123";

import { createDbHandle, setDbHandleForTests, type DbHandle } from "@/db";
import { folders, mailAccounts, mailOps, messages, users } from "@/db/schema";
import { stopBossForTests } from "@/server/jobs/boss";
import { appendToRoleFolder, deleteMessages, markMessages, moveMessages } from "@/server/mail/ops";
import { encryptCredentials } from "@/server/providers/factory";
import { syncAccount, syncFolderById } from "@/server/sync/engine";
import { applyOutbox } from "@/server/sync/outbox";

/**
 * outbox 回放集成测试：本地乐观修改 → 回放到 hoodiecrow → 用独立连接核对服务器状态。
 */

// 与 sync-engine.test.ts 的端口段错开，避免同进程内端口冲突
const PORT = 11600 + Math.floor(Math.random() * 100);
const raw = (subject: string, id: string) =>
  `From: a@example.com\r\nTo: me@example.com\r\nSubject: ${subject}\r\nMessage-ID: <${id}@example.com>\r\nDate: Tue, 08 Sep 2026 10:00:00 +0000\r\n\r\nbody ${id}`;

async function serverState(folder: string): Promise<Array<{ uid: number; flags: string[]; subject?: string }>> {
  const client = new ImapFlow({ host: "127.0.0.1", port: PORT, secure: false, auth: { user: "testuser", pass: "testpass" }, logger: false, disableAutoIdle: true });
  await client.connect();
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    if (!client.mailbox || client.mailbox.exists === 0) return [];
    const list = await client.fetchAll("1:*", { uid: true, flags: true, envelope: true }, { uid: true });
    // 不同服务器 / 路径返回的标记可能带或不带反斜杠，统一去掉再比较
    return list.map((m) => ({ uid: m.uid, flags: [...(m.flags ?? [])].map((f) => f.replace(/^\\/, "")), subject: m.envelope?.subject }));
  } finally {
    lock.release();
    await client.logout();
  }
}

describe("outbox (hoodiecrow + PGlite)", () => {
  let server: ReturnType<typeof hoodiecrow>;
  let handle: DbHandle;
  let userId = "";
  let accountId = "";

  beforeAll(async () => {
    server = hoodiecrow({
      plugins: ["ID", "ENABLE", "CONDSTORE", "SPECIAL-USE", "NAMESPACE", "UNSELECT"],
      storage: {
        INBOX: { messages: [{ raw: raw("one", "o1") }, { raw: raw("two", "o2") }, { raw: raw("three", "o3") }] },
        "": {
          separator: "/",
          folders: {
            Sent: { "special-use": "\\Sent" },
            Drafts: { "special-use": "\\Drafts" },
            Trash: { "special-use": "\\Trash" },
            Archive: { "special-use": "\\Archive" },
          },
        },
      },
    });
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
    handle = await createDbHandle({ pgliteDataDir: null });
    setDbHandleForTests(handle);
    const [user] = await handle.db.insert(users).values({ email: "t@example.com", passwordHash: "x" }).returning();
    userId = user.id;
    const [account] = await handle.db
      .insert(mailAccounts)
      .values({
        userId,
        provider: "imap",
        presetId: "custom",
        email: "testuser",
        imapHost: "127.0.0.1",
        imapPort: PORT,
        imapSecure: false,
        smtpHost: "127.0.0.1",
        smtpPort: 2525,
        smtpSecure: false,
        credentialsEnc: encryptCredentials({ password: "testpass" }),
        syncWindowDays: 365,
      })
      .returning();
    accountId = account.id;
    await syncAccount(accountId, "test");
  });

  afterAll(async () => {
    await stopBossForTests();
    setDbHandleForTests(undefined);
    await handle.close();
    server.close();
  });

  const inboxMessages = async () => {
    const inbox = (await handle.db.query.folders.findFirst({ where: eq(folders.role, "inbox") }))!;
    return { inbox, msgs: await handle.db.query.messages.findMany({ where: eq(messages.folderId, inbox.id) }) };
  };

  test("已读 / 星标：本地立即生效，回放后服务器标记一致", async () => {
    const { inbox, msgs } = await inboxMessages();
    const one = msgs.find((m) => m.subject === "one")!;
    expect(inbox.unreadCount).toBe(3);

    await markMessages(userId, [one.id], { seen: true, flagged: true });
    const local = await handle.db.query.messages.findFirst({ where: eq(messages.id, one.id) });
    expect(local?.seen).toBe(true);
    expect(local?.flagged).toBe(true);
    expect((await handle.db.query.folders.findFirst({ where: eq(folders.id, inbox.id) }))?.unreadCount).toBe(2);

    const r = await applyOutbox(accountId);
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(0);
    const remote = await serverState("INBOX");
    expect(remote.find((m) => m.uid === one.uid)?.flags.sort()).toEqual(["Flagged", "Seen"]);
    const ops = await handle.db.query.mailOps.findMany({ where: eq(mailOps.accountId, accountId) });
    expect(ops.every((o) => o.status === "applied")).toBe(true);
  });

  test("归档：本地移出，服务器上移动到 Archive", async () => {
    const { msgs } = await inboxMessages();
    const two = msgs.find((m) => m.subject === "two")!;
    await moveMessages(userId, [two.id], { role: "archive" });
    expect(await handle.db.query.messages.findFirst({ where: eq(messages.id, two.id) })).toBeUndefined();
    await applyOutbox(accountId);
    expect((await serverState("INBOX")).map((m) => m.subject).sort()).toEqual(["one", "three"]);
    expect((await serverState("Archive")).map((m) => m.subject)).toEqual(["two"]);
  });

  test("删除：先到 Trash，再从 Trash 彻底删除", async () => {
    const { msgs } = await inboxMessages();
    const three = msgs.find((m) => m.subject === "three")!;
    await deleteMessages(userId, [three.id]);
    await applyOutbox(accountId);
    expect((await serverState("Trash")).map((m) => m.subject)).toEqual(["three"]);

    await syncFolderById(accountId, { folderPath: "Trash" });
    const trash = (await handle.db.query.folders.findFirst({ where: eq(folders.role, "trash") }))!;
    const inTrash = await handle.db.query.messages.findMany({ where: eq(messages.folderId, trash.id) });
    expect(inTrash.map((m) => m.subject)).toEqual(["three"]);

    await deleteMessages(userId, [inTrash[0].id]);
    await applyOutbox(accountId);
    expect(await serverState("Trash")).toEqual([]);
  });

  test("草稿 APPEND 到服务器草稿箱", async () => {
    const account = (await handle.db.query.mailAccounts.findFirst({ where: eq(mailAccounts.id, accountId) }))!;
    await appendToRoleFolder(account, "drafts", Buffer.from("Subject: draft one\r\n\r\nhello"), ["Draft"]);
    const r = await applyOutbox(accountId);
    expect(r.applied).toBe(1);
    const drafts = await serverState("Drafts");
    expect(drafts.map((m) => m.subject)).toEqual(["draft one"]);
    expect(drafts[0].flags).toContain("Draft");
  });
});
