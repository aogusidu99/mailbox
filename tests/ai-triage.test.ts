import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.APP_MASTER_KEY = "c".repeat(64);
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "password123";

import { createDbHandle, setDbHandleForTests, type DbHandle } from "@/db";
import { aiAnnotations, aiUsage, folders, mailAccounts, mailOps, messages, users } from "@/db/schema";
import { draftReply } from "@/server/ai/assist";
import { dailyDigest } from "@/server/ai/digest";
import { runRole } from "@/server/ai/client";
import { loadAiSettings, saveAiSettings } from "@/server/ai/settings";
import { triageMessage } from "@/server/ai/triage";
import { stopBossForTests } from "@/server/jobs/boss";
import { encryptCredentials } from "@/server/providers/factory";
import { startFakeOpenAI, type FakeOpenAI } from "./helpers/fake-openai";

/**
 * 端到端（不含 UI）：自定义 OpenAI 兼容厂商 → 分类入库 → 写回 outbox → 降级链 → 用量记录 → 回复起草 → 每日摘要。
 */

describe("AI triage / 降级 / 摘要", () => {
  let handle: DbHandle;
  let fake: FakeOpenAI;
  let userId = "";
  let accountId = "";
  let messageId = "";

  beforeAll(async () => {
    fake = startFakeOpenAI({
      port: 11730,
      textReply: (messages) => (messages.some((m) => m.content.includes("今日邮件摘要")) ? "- 需要处理：Bob 的发票" : "您好，发票已收到，谢谢！\n\n[你的名字]"),
    });
    handle = await createDbHandle({ pgliteDataDir: null });
    setDbHandleForTests(handle);
    const [user] = await handle.db.insert(users).values({ email: "ai@example.com", passwordHash: "x" }).returning();
    userId = user.id;
    const [account] = await handle.db
      .insert(mailAccounts)
      .values({
        userId,
        provider: "gmail",
        presetId: "gmail",
        email: "me@gmail.com",
        imapHost: "imap.gmail.com",
        smtpHost: "smtp.gmail.com",
        credentialsEnc: encryptCredentials({ password: "x" }),
        aiEnabled: true,
      })
      .returning();
    accountId = account.id;
    const [inbox] = await handle.db.insert(folders).values({ accountId, path: "INBOX", name: "INBOX", role: "inbox" }).returning();
    const [msg] = await handle.db
      .insert(messages)
      .values({
        accountId,
        folderId: inbox.id,
        uid: 7,
        subject: "发票已开具",
        fromAddrs: [{ name: "Bob", address: "bob@example.com" }],
        toAddrs: [{ address: "me@gmail.com" }],
        date: new Date(),
        textBody: "您好，9 月发票见附件。",
        bodyFetchedAt: new Date(),
      })
      .returning();
    messageId = msg.id;

    // 把假厂商配成默认，并让 triage 先用会 500 的模型以验证降级
    await saveAiSettings(userId, (s) => ({
      keys: { ...s.keys, fake: "test-key" },
      data: {
        ...s.data,
        customProviders: [{ id: "fake", name: "Fake AI", baseUrl: fake.baseUrl }],
        candidates: { ...s.data.candidates, fake: [{ id: "fake-broken", name: "Broken" }, { id: "fake-smart", name: "Smart" }, { id: "fake-fast", name: "Fast" }] },
        defaultProvider: "fake",
        defaultModel: "fake-smart",
        roles: { triage: { provider: "fake", model: "fake-broken" } },
      },
    }));
  });

  afterAll(async () => {
    await stopBossForTests();
    setDbHandleForTests(undefined);
    await handle.close();
    fake.stop();
  });

  test("设置保存后 Key 加密存库，环境变量种子不落库", async () => {
    const row = await handle.db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(row).toBeDefined();
    const loaded = await loadAiSettings(userId);
    expect(loaded.keys.fake).toBe("test-key");
    expect(loaded.data.defaultProvider).toBe("fake");
  });

  test("triage：首选模型 500 → 降级到候选池下一个，结果入库并写回 Gmail 标签", async () => {
    const out = await triageMessage(accountId, messageId);
    expect(out?.category).toBe("billing");
    const ann = await handle.db.query.aiAnnotations.findFirst({ where: eq(aiAnnotations.messageId, messageId) });
    expect(ann?.priority).toBe("high");
    expect(ann?.summary).toContain("发票");
    expect(ann?.actionItems).toEqual([{ title: "核对发票金额", dueAt: "2026-09-15" }]);
    expect(ann?.model).toBe("fake-smart");

    const usage = await handle.db.query.aiUsage.findMany({ where: eq(aiUsage.userId, userId) });
    expect(usage).toHaveLength(1);
    expect(usage[0].feature).toBe("triage");
    expect(usage[0].fallbackFrom).toBe("fake-broken");
    expect(usage[0].inputTokens).toBe(100);

    const ops = await handle.db.query.mailOps.findMany({ where: eq(mailOps.accountId, accountId) });
    expect(ops.map((o) => o.type)).toEqual(["create_folder", "set_labels"]);
    const payload = ops[1].payload as { op: { add: string[]; uids: number[] } };
    expect(payload.op.add).toEqual(["AI/Billing"]);
    expect(payload.op.uids).toEqual([7]);
  });

  test("已有标注不会重复分析；force 会重新分析", async () => {
    const before = fake.requests.length;
    await triageMessage(accountId, messageId);
    expect(fake.requests.length).toBe(before);
    await triageMessage(accountId, messageId, { force: true });
    expect(fake.requests.length).toBeGreaterThan(before);
  });

  test("runRole 走全局默认模型并记录用量", async () => {
    const r = await runRole({ userId, role: "summary", messages: [{ role: "user", content: "hi" }] });
    expect(r.model).toBe("fake-smart");
    expect(r.providerId).toBe("fake");
    expect(r.fallbackFrom).toBeUndefined();
  });

  test("回复起草与每日摘要", async () => {
    const draft = await draftReply(userId, messageId, "简短确认");
    expect(draft.text).toContain("发票已收到");
    const day = new Date();
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const digest = await dailyDigest(userId, key);
    expect(digest.items).toHaveLength(1);
    expect(digest.content).toContain("Bob");
    const again = await dailyDigest(userId, key);
    expect(again.cached).toBe(true);
  });
});
