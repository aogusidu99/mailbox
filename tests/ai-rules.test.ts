import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.APP_MASTER_KEY = "d".repeat(64);
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "password123";

import { createDbHandle, setDbHandleForTests, type DbHandle } from "@/db";
import { folders, mailAccounts, mailOps, messages, rules, users, type CompiledRule } from "@/db/schema";
import { applyRulesToMessage, compileRule, createRule, evaluateRule, messageContext, previewRule, runRuleNow, type RuleContext } from "@/server/ai/rules";
import { saveAiSettings } from "@/server/ai/settings";
import { stopBossForTests } from "@/server/jobs/boss";
import { encryptCredentials } from "@/server/providers/factory";
import { startFakeOpenAI, type FakeOpenAI } from "./helpers/fake-openai";

const ctx = (partial: Partial<RuleContext>): RuleContext => ({
  from: "",
  to: "",
  subject: "",
  body: "",
  category: "",
  priority: "",
  hasAttachment: false,
  needsReply: false,
  listId: "",
  ...partial,
});

describe("规则求值（纯函数）", () => {
  test("all / any 与各种操作符", () => {
    const rule: CompiledRule = {
      name: "t",
      match: "all",
      conditions: [
        { field: "from", op: "contains", value: "NEWSLETTER" },
        { field: "hasAttachment", op: "is_false" },
      ],
      actions: [{ type: "mark_read" }],
    };
    expect(evaluateRule(rule, ctx({ from: "Weekly Newsletter <news@x.com>" }))).toBe(true);
    expect(evaluateRule(rule, ctx({ from: "Weekly Newsletter <news@x.com>", hasAttachment: true }))).toBe(false);
    expect(evaluateRule({ ...rule, match: "any" }, ctx({ from: "bob@x.com" }))).toBe(true);
    expect(evaluateRule({ ...rule, conditions: [{ field: "subject", op: "matches", value: "^\\[JIRA\\]" }] }, ctx({ subject: "[JIRA] Ticket" }))).toBe(true);
    expect(evaluateRule({ ...rule, conditions: [{ field: "subject", op: "matches", value: "(" }] }, ctx({ subject: "x" }))).toBe(false);
    expect(evaluateRule({ ...rule, conditions: [{ field: "priority", op: "equals", value: "high" }] }, ctx({ priority: "high" }))).toBe(true);
    expect(evaluateRule({ ...rule, conditions: [{ field: "needsReply", op: "is_true" }] }, ctx({ needsReply: true }))).toBe(true);
    expect(evaluateRule({ ...rule, conditions: [] }, ctx({}))).toBe(false);
  });
});

describe("规则编译 / 执行（假 AI + PGlite）", () => {
  let handle: DbHandle;
  let fake: FakeOpenAI;
  let userId = "";
  let accountId = "";
  let invoiceId = "";
  let otherId = "";

  beforeAll(async () => {
    fake = startFakeOpenAI({ port: 11750 });
    handle = await createDbHandle({ pgliteDataDir: null });
    setDbHandleForTests(handle);
    const [user] = await handle.db.insert(users).values({ email: "r@example.com", passwordHash: "x" }).returning();
    userId = user.id;
    const [account] = await handle.db
      .insert(mailAccounts)
      .values({ userId, provider: "imap", presetId: "custom", email: "me@x.com", imapHost: "h", smtpHost: "h", credentialsEnc: encryptCredentials({ password: "x" }) })
      .returning();
    accountId = account.id;
    const [inbox] = await handle.db.insert(folders).values({ accountId, path: "INBOX", name: "INBOX", role: "inbox" }).returning();
    const [invoice] = await handle.db
      .insert(messages)
      .values({ accountId, folderId: inbox.id, uid: 1, subject: "9 月发票", fromAddrs: [{ address: "bob@x.com" }], date: new Date(), textBody: "见附件", bodyFetchedAt: new Date() })
      .returning();
    const [other] = await handle.db
      .insert(messages)
      .values({ accountId, folderId: inbox.id, uid: 2, subject: "周报", fromAddrs: [{ address: "alice@x.com" }], date: new Date(), textBody: "本周进展", bodyFetchedAt: new Date() })
      .returning();
    invoiceId = invoice.id;
    otherId = other.id;
    await saveAiSettings(userId, (s) => ({
      keys: { ...s.keys, fake: "test-key" },
      data: {
        ...s.data,
        customProviders: [{ id: "fake", name: "Fake", baseUrl: fake.baseUrl }],
        candidates: { ...s.data.candidates, fake: [{ id: "fake-smart", name: "Smart" }] },
        defaultProvider: "fake",
        defaultModel: "fake-smart",
      },
    }));
  });

  afterAll(async () => {
    await stopBossForTests();
    setDbHandleForTests(undefined);
    await handle.close();
    fake.stop();
  });

  test("自然语言编译成规则并在收件箱上预览", async () => {
    const compiled = await compileRule(userId, "发票邮件标为已读并加星标");
    expect(compiled.name).toBe("发票归档");
    expect(compiled.actions.map((a) => a.type)).toEqual(["mark_read", "flag"]);
    const preview = await previewRule(userId, compiled);
    expect(preview.scanned).toBe(2);
    expect(preview.matches.map((m) => m.subject)).toEqual(["9 月发票"]);
  });

  test("新邮件命中规则 → 本地更新 + outbox 操作；未命中不动", async () => {
    const compiled = await compileRule(userId, "发票邮件标为已读并加星标");
    await createRule(userId, { naturalText: "发票邮件标为已读并加星标", compiled });

    expect(await applyRulesToMessage(accountId, invoiceId)).toEqual(["发票归档"]);
    const invoice = await handle.db.query.messages.findFirst({ where: eq(messages.id, invoiceId) });
    expect(invoice?.seen).toBe(true);
    expect(invoice?.flagged).toBe(true);
    const ops = await handle.db.query.mailOps.findMany({ where: eq(mailOps.accountId, accountId) });
    expect(ops.length).toBe(2);

    expect(await applyRulesToMessage(accountId, otherId)).toEqual([]);
    const other = await handle.db.query.messages.findFirst({ where: eq(messages.id, otherId) });
    expect(other?.seen).toBe(false);

    const rule = (await handle.db.query.rules.findMany({ where: eq(rules.userId, userId) }))[0];
    expect(rule.runCount).toBe(1);
    expect(rule.lastRunAt).not.toBeNull();
  });

  test("立即执行对已有邮件生效并累计次数", async () => {
    const rule = (await handle.db.query.rules.findMany({ where: eq(rules.userId, userId) }))[0];
    const n = await runRuleNow(userId, rule.id);
    expect(n).toBe(1);
    const updated = await handle.db.query.rules.findFirst({ where: eq(rules.id, rule.id) });
    expect(updated?.runCount).toBe(2);
  });

  test("messageContext 从邮件与标注生成匹配上下文", async () => {
    const invoice = (await handle.db.query.messages.findFirst({ where: eq(messages.id, invoiceId) }))!;
    const c = messageContext(invoice, { category: "billing", priority: "high", reason: "x（需要回复）" });
    expect(c.category).toBe("billing");
    expect(c.needsReply).toBe(true);
    expect(c.from).toContain("bob@x.com");
  });
});
