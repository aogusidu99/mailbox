import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.APP_MASTER_KEY = "e".repeat(64);
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "password123";

import { createDbHandle, setDbHandleForTests, type DbHandle } from "@/db";
import { aiUsage, folders, mailAccounts, messageEmbeddings, messages, users } from "@/db/schema";
import { chatTurn } from "@/server/ai/agent";
import { backfillEmbeddings, cosine, embedMessage, embeddingConfigured, semanticSearch } from "@/server/ai/embeddings";
import { loadAiSettings, saveAiSettings } from "@/server/ai/settings";
import { stopBossForTests } from "@/server/jobs/boss";
import { encryptCredentials } from "@/server/providers/factory";
import { parseListUnsubscribe, unsubscribe } from "@/server/mail/unsubscribe";
import { startFakeOpenAI, type FakeOpenAI } from "./helpers/fake-openai";

describe("语义搜索 / 对话 Agent / 退订", () => {
  let handle: DbHandle;
  let fake: FakeOpenAI;
  let userId = "";
  let accountId = "";
  let invoiceId = "";
  let unsubHits = 0;
  let unsubServer: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    fake = startFakeOpenAI({ port: 11760 });
    unsubServer = Bun.serve({
      port: 11761,
      async fetch(req) {
        if (req.method === "POST" && (await req.text()) === "List-Unsubscribe=One-Click") {
          unsubHits += 1;
          return new Response("ok");
        }
        return new Response("bad", { status: 400 });
      },
    });
    handle = await createDbHandle({ pgliteDataDir: null });
    setDbHandleForTests(handle);
    const [user] = await handle.db.insert(users).values({ email: "a@example.com", passwordHash: "x" }).returning();
    userId = user.id;
    const [account] = await handle.db
      .insert(mailAccounts)
      .values({ userId, provider: "imap", presetId: "custom", email: "me@x.com", imapHost: "h", smtpHost: "h", credentialsEnc: encryptCredentials({ password: "x" }) })
      .returning();
    accountId = account.id;
    const [inbox] = await handle.db.insert(folders).values({ accountId, path: "INBOX", name: "INBOX", role: "inbox" }).returning();
    const rows = await handle.db
      .insert(messages)
      .values([
        { accountId, folderId: inbox.id, uid: 1, subject: "发票已开具", fromAddrs: [{ name: "Bob", address: "bob@x.com" }], date: new Date(), textBody: "9 月发票见附件 invoice invoice invoice", bodyFetchedAt: new Date() },
        { accountId, folderId: inbox.id, uid: 2, subject: "周末爬山", fromAddrs: [{ name: "Alice", address: "alice@x.com" }], date: new Date(), textBody: "周六去爬山吗 hiking hiking", bodyFetchedAt: new Date() },
        {
          accountId,
          folderId: inbox.id,
          uid: 3,
          subject: "本周精选",
          fromAddrs: [{ name: "News", address: "news@x.com" }],
          date: new Date(),
          textBody: "newsletter",
          bodyFetchedAt: new Date(),
          headers: { "list-unsubscribe": "<mailto:unsub@x.com?subject=unsubscribe>, <http://127.0.0.1:11761/unsub>", "list-unsubscribe-post": "List-Unsubscribe=One-Click" },
        },
      ])
      .returning();
    invoiceId = rows[0].id;
    await saveAiSettings(userId, (s) => ({
      keys: { ...s.keys, fake: "test-key" },
      data: {
        ...s.data,
        customProviders: [{ id: "fake", name: "Fake", baseUrl: fake.baseUrl }],
        candidates: { ...s.data.candidates, fake: [{ id: "fake-smart", name: "Smart" }, { id: "fake-embed", name: "Embed" }] },
        defaultProvider: "fake",
        defaultModel: "fake-smart",
        roles: { embedding: { provider: "fake", model: "fake-embed" }, chat: { provider: "fake", model: "fake-smart" } },
      },
    }));
  });

  afterAll(async () => {
    await stopBossForTests();
    setDbHandleForTests(undefined);
    await handle.close();
    fake.stop();
    unsubServer.stop(true);
  });

  test("cosine 与向量化入库", async () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(embeddingConfigured(await loadAiSettings(userId))).toBe(true);
    const n = await backfillEmbeddings(userId, 10);
    expect(n).toBe(3);
    for (const m of await handle.db.query.messages.findMany()) expect(await embedMessage(accountId, m.id)).toBe(true);
    const stored = await handle.db.query.messageEmbeddings.findMany({ where: eq(messageEmbeddings.accountId, accountId) });
    expect(stored).toHaveLength(3);
    expect(stored[0].dims).toBe(8);
  });

  test("语义搜索按相似度排序", async () => {
    const hits = await semanticSearch(userId, "9 月发票见附件 invoice invoice invoice");
    expect(hits[0].subject).toBe("发票已开具");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    const usage = await handle.db.query.aiUsage.findMany({ where: eq(aiUsage.userId, userId) });
    expect(usage.some((u) => u.feature === "embedding")).toBe(true);
  });

  test("对话 Agent：工具检索 → 操作建议 → 最终回答", async () => {
    const r = await chatTurn(userId, [], "帮我找发票");
    expect(r.trace.map((t) => t.tool)).toEqual(["search_mail", "propose_actions"]);
    expect(r.trace[0].summary).toContain("1 条");
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ messageId: invoiceId, action: "flag", subject: "发票已开具" });
    expect(r.reply).toContain("发票");
  });

  test("退订：解析头部并优先一键退订", async () => {
    const parsed = parseListUnsubscribe("<mailto:a@x.com?subject=unsubscribe>, <https://x.com/u?id=1>");
    expect(parsed.mailto[0].pathname).toBe("a@x.com");
    expect(parsed.https[0].host).toBe("x.com");
    const news = (await handle.db.query.messages.findMany()).find((m) => m.subject === "本周精选")!;
    const r = await unsubscribe(userId, news.id);
    expect(r).toEqual({ method: "one-click", detail: "127.0.0.1:11761" });
    expect(unsubHits).toBe(1);
  });
});
