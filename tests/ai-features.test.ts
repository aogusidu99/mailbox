import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.APP_MASTER_KEY = "d".repeat(64);
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "password123";

import { createDbHandle, setDbHandleForTests, type DbHandle } from "@/db";
import { aiAnnotations, folders, mailAccounts, messageTranslations, messages, users } from "@/db/schema";
import { deleteThread, getThreadMessages, listThreads, sendChatMessage } from "@/server/ai/chat-store";
import { executeDispositions, generateDigest, loadDigest, replanDigest, resolveRange, todayKey } from "@/server/ai/digest";
import { saveAiSettings } from "@/server/ai/settings";
import { translateMessage } from "@/server/ai/translate";
import { stopBossForTests } from "@/server/jobs/boss";
import { encryptCredentials } from "@/server/providers/factory";
import { startFakeOpenAI, type FakeOpenAI } from "./helpers/fake-openai";

/**
 * 新功能端到端（不含 UI）：邮件翻译缓存、对话历史持久化、摘要处理台（时间段/处理意见/自然语言调整/批量执行）。
 */

describe("翻译 / 对话历史 / 摘要处理台", () => {
  let handle: DbHandle;
  let fake: FakeOpenAI;
  let userId = "";
  let accountId = "";
  let invoiceId = "";

  beforeAll(async () => {
    fake = startFakeOpenAI({
      port: 11740,
      textReply: (m) => (m.some((x) => x.content.includes("今日邮件摘要")) ? "- 需要处理：Bob 的发票" : "ok"),
      jsonReply: (m) => {
        const sys = m.find((x) => x.role === "system")?.content ?? "";
        const id = m.map((x) => x.content).join("\n").match(/id=([0-9a-f-]{36})/)?.[1] ?? "";
        if (sys.includes("专业的邮件翻译")) return { subject: "Rechnung ausgestellt", body: "übersetzter Text" };
        if (sys.includes("调整后的完整处理意见")) return { dispositions: [{ messageId: id, action: "mark_read", value: null, reason: "通知类，标记已读", replyPoints: null }] };
        if (sys.includes("处理意见")) return { dispositions: [{ messageId: id, action: "flag", value: null, reason: "发票需跟进", replyPoints: null }] };
        return { category: "billing", priority: "high", needsReply: false, summary: "发票", actionItems: [], reason: "x" };
      },
    });
    handle = await createDbHandle({ pgliteDataDir: null });
    setDbHandleForTests(handle);
    const [user] = await handle.db.insert(users).values({ email: "f@example.com", passwordHash: "x" }).returning();
    userId = user.id;
    const [account] = await handle.db
      .insert(mailAccounts)
      .values({ userId, provider: "imap", presetId: "custom", email: "me@x.com", imapHost: "h", smtpHost: "h", credentialsEnc: encryptCredentials({ password: "x" }) })
      .returning();
    accountId = account.id;
    const [inbox] = await handle.db.insert(folders).values({ accountId, path: "INBOX", name: "INBOX", role: "inbox" }).returning();
    const [msg] = await handle.db
      .insert(messages)
      .values({
        accountId,
        folderId: inbox.id,
        uid: 1,
        subject: "发票已开具",
        fromAddrs: [{ name: "Bob", address: "bob@x.com" }],
        toAddrs: [{ address: "me@x.com" }],
        date: new Date(),
        textBody: "您好，9 月发票见附件 invoice。",
        bodyFetchedAt: new Date(),
      })
      .returning();
    invoiceId = msg.id;
    await handle.db.insert(aiAnnotations).values({
      messageId: invoiceId,
      category: "billing",
      priority: "high",
      summary: "9 月发票已开具，请查收。",
      actionItems: [],
      reason: "账单类邮件",
      model: "fake-smart",
      promptVersion: "test",
    });

    await saveAiSettings(userId, (s) => ({
      keys: { ...s.keys, fake: "test-key" },
      data: {
        ...s.data,
        customProviders: [{ id: "fake", name: "Fake", baseUrl: fake.baseUrl }],
        candidates: { ...s.data.candidates, fake: [{ id: "fake-smart", name: "Smart" }] },
        defaultProvider: "fake",
        defaultModel: "fake-smart",
        roles: { chat: { provider: "fake", model: "fake-smart" } },
      },
    }));
  });

  afterAll(async () => {
    await stopBossForTests();
    setDbHandleForTests(undefined);
    await handle.close();
    fake.stop();
  });

  test("邮件翻译：结构化返回、按语言缓存、可重译、拒绝未配置语言", async () => {
    const r = await translateMessage(userId, invoiceId, "de");
    expect(r.body).toBe("übersetzter Text");
    expect(r.subject).toBe("Rechnung ausgestellt");
    expect(r.cached).toBe(false);

    const again = await translateMessage(userId, invoiceId, "de");
    expect(again.cached).toBe(true);

    const refreshed = await translateMessage(userId, invoiceId, "de", { refresh: true });
    expect(refreshed.cached).toBe(false);

    const stored = await handle.db.query.messageTranslations.findMany({ where: eq(messageTranslations.messageId, invoiceId) });
    expect(stored).toHaveLength(1); // 同语言只保留一份

    await expect(translateMessage(userId, invoiceId, "xx")).rejects.toThrow();
  });

  test("对话历史：新建会话→落库→续聊→列出→删除", async () => {
    const first = await sendChatMessage(userId, null, "帮我找发票");
    expect(first.threadId).toBeTruthy();
    expect(first.turn.reply).toContain("发票");

    const threads = await listThreads(userId);
    expect(threads).toHaveLength(1);
    expect(threads[0].title).toContain("帮我找发票");

    const msgs = await getThreadMessages(userId, first.threadId);
    expect(msgs).toHaveLength(2);
    expect(msgs?.[0].role).toBe("user");
    expect(msgs?.[1].role).toBe("assistant");
    expect(msgs?.[1].proposals?.length).toBeGreaterThan(0);

    await sendChatMessage(userId, first.threadId, "谢谢");
    expect((await getThreadMessages(userId, first.threadId))?.length).toBe(4);

    // 越权访问返回 null
    expect(await getThreadMessages("00000000-0000-0000-0000-000000000000", first.threadId)).toBeNull();

    await deleteThread(userId, first.threadId);
    expect(await listThreads(userId)).toHaveLength(0);
  });

  test("时间段解析：day / custom 的 periodKey", async () => {
    const day = await resolveRange(userId, "day", {});
    expect(day.periodKey).toBe(`day:${todayKey()}`);
    const custom = await resolveRange(userId, "custom", { from: "2026-09-01", to: "2026-09-07" });
    expect(custom.periodKey).toBe("custom:2026-09-01..2026-09-07");
    expect(custom.label).toBe("2026-09-01 ~ 2026-09-07");
  });

  test("摘要处理台：生成概览+处理意见 → 缓存 → 自然语言调整 → 确认执行", async () => {
    const d = await generateDigest(userId, "day", { withPlan: true });
    expect(d.items).toHaveLength(1);
    expect(d.content).toContain("Bob");
    expect(d.plan).toHaveLength(1);
    expect(d.plan[0]).toMatchObject({ messageId: invoiceId, action: "flag" });

    // 只读加载命中缓存
    const cached = await loadDigest(userId, "day", {});
    expect(cached.cached).toBe(true);
    expect(cached.plan[0].action).toBe("flag");

    // 自然语言调整：改成标记已读
    const replanned = await replanDigest(userId, d.range.periodKey, "这是通知，标记已读即可");
    expect(replanned.plan[0].action).toBe("mark_read");

    // 确认执行：mark_read → 邮件变已读
    const exec = await executeDispositions(userId, d.range.periodKey, [invoiceId]);
    expect(exec.done).toContain(invoiceId);
    const msg = await handle.db.query.messages.findFirst({ where: eq(messages.id, invoiceId) });
    expect(msg?.seen).toBe(true);

    // 执行后状态标记为 done
    const after = await loadDigest(userId, "day", {});
    expect(after.plan[0].status).toBe("done");
  });
});
