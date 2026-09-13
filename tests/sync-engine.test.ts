import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import hoodiecrow from "hoodiecrow-imap";
import { ImapFlow } from "imapflow";

// 环境变量必须在业务模块首次读取 env 之前设置
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.APP_MASTER_KEY = "a".repeat(64);
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "password123";

import { createDbHandle, setDbHandleForTests, type DbHandle } from "@/db";
import { attachments, folders, mailAccounts, messages, users } from "@/db/schema";
import { stopBossForTests } from "@/server/jobs/boss";
import { encryptCredentials } from "@/server/providers/factory";
import { fetchPendingBodies, syncAccount, syncFolderById } from "@/server/sync/engine";

/**
 * 集成测试：本地 hoodiecrow IMAP 服务器 + 内存 PGlite，跑通
 * 初次同步 → 正文拉取 → 服务器端变化（标记 / 新邮件 / 删除）的增量同步。
 */

// 端口段：11430–11529（outbox.test.ts 用 11600–11699）
const PORT = 11430 + Math.floor(Math.random() * 100);

/** 真实邮件里非 ASCII 主题按 RFC 2047 编码，正文用 base64 传输编码 */
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

function rawMessage(opts: { from: string; subject: string; id: string; date: string; body?: string; attachment?: boolean }) {
  const headers = [
    `From: ${opts.from}`,
    "To: me@example.com",
    `Subject: ${encodeWord(opts.subject)}`,
    `Message-ID: <${opts.id}@example.com>`,
    `Date: ${opts.date}`,
  ];
  if (!opts.attachment) {
    const body = Buffer.from(opts.body ?? "Hello", "utf8").toString("base64");
    return `${headers.join("\r\n")}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`;
  }
  return (
    `${headers.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n` +
    `--b1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hi <b>there</b></p><img src="https://tracker.example.com/p.gif">\r\n` +
    `--b1\r\nContent-Type: application/pdf; name="report.pdf"\r\nContent-Disposition: attachment; filename="report.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQ=\r\n--b1--`
  );
}

describe("sync engine (hoodiecrow + PGlite)", () => {
  let server: ReturnType<typeof hoodiecrow>;
  let handle: DbHandle;
  let accountId = "";

  beforeAll(async () => {
    server = hoodiecrow({
      plugins: ["ID", "IDLE", "ENABLE", "CONDSTORE", "SPECIAL-USE", "NAMESPACE", "UNSELECT"],
      id: { name: "hoodiecrow", version: "test" },
      storage: {
        INBOX: {
          messages: [
            { raw: rawMessage({ from: "Alice <alice@example.com>", subject: "第一封", id: "m1", date: "Mon, 01 Sep 2026 10:00:00 +0000", body: "你好，世界" }), flags: ["\\Seen"] },
            { raw: rawMessage({ from: "Bob <bob@example.com>", subject: "带附件", id: "m2", date: "Tue, 02 Sep 2026 10:00:00 +0000", attachment: true }) },
            { raw: rawMessage({ from: "Old <old@example.com>", subject: "很旧的邮件", id: "m0", date: "Mon, 01 Jan 2024 10:00:00 +0000" }), internaldate: "01-Jan-2024 10:00:00 +0000" },
          ],
        },
        "": {
          separator: "/",
          folders: {
            Sent: { "special-use": "\\Sent" },
            Drafts: { "special-use": "\\Drafts" },
            Trash: { "special-use": "\\Trash" },
          },
        },
      },
    });
    await new Promise<void>((resolve) => server.listen(PORT, resolve));

    handle = await createDbHandle({ pgliteDataDir: null });
    setDbHandleForTests(handle);

    const [user] = await handle.db.insert(users).values({ email: "t@example.com", passwordHash: "x" }).returning();
    const [account] = await handle.db
      .insert(mailAccounts)
      .values({
        userId: user.id,
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
        syncWindowDays: 60,
      })
      .returning();
    accountId = account.id;
  });

  afterAll(async () => {
    await stopBossForTests();
    setDbHandleForTests(undefined);
    await handle.close();
    server.close();
  });

  test("初次同步：文件夹、最近邮件与附件元数据入库", async () => {
    await syncAccount(accountId, "test");

    const account = await handle.db.query.mailAccounts.findFirst({ where: eq(mailAccounts.id, accountId) });
    expect(account?.syncStatus).toBe("idle");
    expect(account?.initialSyncDone).toBe(true);

    const fs = await handle.db.query.folders.findMany({ where: eq(folders.accountId, accountId) });
    const roles = Object.fromEntries(fs.map((f) => [f.path, f.role]));
    expect(roles["INBOX"]).toBe("inbox");
    expect(roles["Sent"]).toBe("sent");
    expect(roles["Trash"]).toBe("trash");

    const inbox = fs.find((f) => f.role === "inbox")!;
    expect(inbox.uidNext).toBe(4);
    expect(inbox.uidValidity).toBe(1);

    const msgs = await handle.db.query.messages.findMany({ where: eq(messages.folderId, inbox.id) });
    // 60 天窗口：2026-09 的两封在内，2024 的那封不在
    expect(msgs.map((m) => m.subject).sort()).toEqual(["带附件", "第一封"]);
    const first = msgs.find((m) => m.subject === "第一封")!;
    expect(first.seen).toBe(true);
    expect(first.fromAddrs).toEqual([{ name: "Alice", address: "alice@example.com" }]);
    expect(first.threadId).toBe("<m1@example.com>");

    const withAtt = msgs.find((m) => m.subject === "带附件")!;
    expect(withAtt.hasAttachments).toBe(true);
    const atts = await handle.db.query.attachments.findMany({ where: eq(attachments.messageId, withAtt.id) });
    expect(atts).toHaveLength(1);
    expect(atts[0].filename).toBe("report.pdf");
    expect(atts[0].part).toBe("2");
  });

  test("正文拉取：文本 / HTML / 摘要入库", async () => {
    const inbox = (await handle.db.query.folders.findFirst({ where: eq(folders.role, "inbox") }))!;
    const r = await fetchPendingBodies(accountId, inbox.id);
    expect(r.fetched).toBe(2);
    expect(r.remaining).toBe(0);
    const msgs = await handle.db.query.messages.findMany({ where: eq(messages.folderId, inbox.id) });
    const first = msgs.find((m) => m.subject === "第一封")!;
    expect(first.textBody?.trim()).toBe("你好，世界");
    expect(first.snippet).toBe("你好，世界");
    const html = msgs.find((m) => m.subject === "带附件")!;
    expect(html.htmlBody).toContain("<b>there</b>");
    expect(html.snippet).toContain("Hi there");
  });

  test("增量同步：服务器端标记变化、新邮件与删除都被同步回本地", async () => {
    // 用另一条连接模拟其它客户端的操作
    const client = new ImapFlow({ host: "127.0.0.1", port: PORT, secure: false, auth: { user: "testuser", pass: "testpass" }, logger: false, disableAutoIdle: true });
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.messageFlagsAdd("2", ["\\Flagged"], { uid: true });
      await client.messageFlagsAdd("1", ["\\Seen"], { uid: true });
      await client.append("INBOX", rawMessage({ from: "Carol <carol@example.com>", subject: "新来的", id: "m3", date: "Wed, 03 Sep 2026 10:00:00 +0000" }));
      await client.messageMove("1", "Trash", { uid: true });
    } finally {
      lock.release();
    }
    await client.logout();

    const r = await syncFolderById(accountId, { folderPath: "INBOX" });
    expect(r?.newCount).toBe(1);
    expect(r?.deleted).toBe(1);

    const inbox = (await handle.db.query.folders.findFirst({ where: eq(folders.role, "inbox") }))!;
    const msgs = await handle.db.query.messages.findMany({ where: eq(messages.folderId, inbox.id) });
    expect(msgs.map((m) => m.subject).sort()).toEqual(["带附件", "新来的"]);
    expect(msgs.find((m) => m.subject === "带附件")?.flagged).toBe(true);
    expect(inbox.uidNext).toBe(5);
  });
});
