import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { aiAnnotations, folders, mailAccounts, messages, rules, type CompiledRule, type Message, type Rule } from "@/db/schema";
import { stripHtml } from "@/lib/quote";
import { deleteMessages, enqueueRawOperation, loadOwnedMessages, markMessages, moveMessages, setGmailLabels } from "@/server/mail/ops";
import { runRole } from "./client";

/**
 * 自然语言规则：用 rules 等级把「把所有发票邮件归档到 Finance」编译成结构化条件 + 动作，
 * 新邮件（拉取正文 / AI 分类后）逐条匹配并执行，动作经 outbox 同步到服务器。
 */

export const compiledRuleSchema = z.object({
  name: z.string().min(1).max(60),
  match: z.enum(["all", "any"]),
  conditions: z
    .array(
      z.object({
        field: z.enum(["from", "to", "subject", "body", "category", "priority", "hasAttachment", "needsReply", "listId"]),
        op: z.enum(["contains", "not_contains", "equals", "starts_with", "ends_with", "matches", "is_true", "is_false"]),
        // AI 输出用 null，前端回传时 undefined 会被 JSON 丢掉，两种都接受
        value: z.string().max(200).nullable().optional(),
      }),
    )
    .min(1)
    .max(8),
  actions: z
    .array(
      z.object({
        type: z.enum(["archive", "trash", "mark_read", "mark_unread", "flag", "junk", "move", "label"]),
        value: z.string().max(120).nullable().optional(),
      }),
    )
    .min(1)
    .max(5),
  stopProcessing: z.boolean().optional(),
});

export const RULES_SYSTEM = `你是邮件规则编译器。把用户用自然语言描述的邮件处理规则，转换成结构化 JSON 规则。

可用字段（field）：from（发件人名字+地址）、to（收件人）、subject（主题）、body（正文摘要）、category（AI 分类：important/todo/notification/billing/newsletter/promotion/social/personal/other）、priority（AI 优先级：high/normal/low）、hasAttachment（是否有附件）、needsReply（AI 判断是否需要回复）、listId（邮件列表 ID，订阅类邮件常有）。
可用操作符（op）：contains / not_contains / equals / starts_with / ends_with / matches（正则）/ is_true / is_false（布尔字段用后两者，value 填 null）。
可用动作（type）：archive（归档）、trash（删除到已删除）、mark_read、mark_unread、flag（星标）、junk（垃圾邮件）、move（移动到文件夹，value 填文件夹名）、label（打 Gmail 标签，value 填标签名）。
规则：
- 文本匹配不区分大小写；
- match 为 all 表示全部条件都满足，any 表示任一满足；
- 用户说「发票 / 账单」这类语义类别时，优先用 category 字段（billing 等），同时可以加 subject contains 作为补充（此时 match 用 any）；
- name 用不超过 20 字的中文概括；stopProcessing 默认 false。`;

export type CompiledRuleInput = z.infer<typeof compiledRuleSchema>;

function normalizeCompiled(input: CompiledRuleInput): CompiledRule {
  return {
    name: input.name,
    match: input.match,
    conditions: input.conditions.map((c) => ({ field: c.field, op: c.op, value: c.value ?? undefined })),
    actions: input.actions.map((a) => ({ type: a.type, value: a.value ?? undefined })),
    stopProcessing: input.stopProcessing ?? false,
  };
}

/** 自然语言 → 结构化规则 */
export async function compileRule(userId: string, naturalText: string): Promise<CompiledRule> {
  const r = await runRole<CompiledRuleInput>({
    userId,
    role: "rules",
    schema: compiledRuleSchema,
    schemaName: "rule",
    maxTokens: 1024,
    messages: [
      { role: "system", content: RULES_SYSTEM },
      { role: "user", content: naturalText },
    ],
  });
  if (!r.json) throw new Error("AI 没有返回规则");
  return normalizeCompiled(r.json);
}

export interface RuleContext {
  from: string;
  to: string;
  subject: string;
  body: string;
  category: string;
  priority: string;
  hasAttachment: boolean;
  needsReply: boolean;
  listId: string;
}

export function messageContext(m: Message, ai?: { category: string | null; priority: string | null; reason: string | null } | null): RuleContext {
  const fmt = (list: Array<{ name?: string; address: string }>) => list.map((a) => `${a.name ?? ""} ${a.address}`).join(" ");
  const listId = m.headers?.["list-id"];
  return {
    from: fmt(m.fromAddrs),
    to: `${fmt(m.toAddrs)} ${fmt(m.ccAddrs)}`,
    subject: m.subject ?? "",
    body: (m.textBody?.trim() || (m.htmlBody ? stripHtml(m.htmlBody, 4000) : "") || m.snippet || "").slice(0, 4000),
    category: ai?.category ?? "",
    priority: ai?.priority ?? "",
    hasAttachment: m.hasAttachments,
    needsReply: (ai?.reason ?? "").includes("需要回复"),
    listId: Array.isArray(listId) ? listId.join(" ") : (listId ?? ""),
  };
}

function testCondition(c: CompiledRule["conditions"][number], ctx: RuleContext): boolean {
  const raw = ctx[c.field];
  if (typeof raw === "boolean") {
    if (c.op === "is_true") return raw;
    if (c.op === "is_false") return !raw;
    return false;
  }
  const text = String(raw).toLowerCase();
  const value = (c.value ?? "").toLowerCase();
  switch (c.op) {
    case "contains":
      return value !== "" && text.includes(value);
    case "not_contains":
      return value === "" || !text.includes(value);
    case "equals":
      return text.trim() === value.trim();
    case "starts_with":
      return text.startsWith(value);
    case "ends_with":
      return text.endsWith(value);
    case "matches":
      try {
        return new RegExp(c.value ?? "", "i").test(String(raw));
      } catch {
        return false;
      }
    case "is_true":
      return text !== "" && text !== "false";
    case "is_false":
      return text === "" || text === "false";
  }
  return false;
}

export function evaluateRule(rule: CompiledRule, ctx: RuleContext): boolean {
  if (rule.conditions.length === 0) return false;
  const results = rule.conditions.map((c) => testCondition(c, ctx));
  return rule.match === "all" ? results.every(Boolean) : results.some(Boolean);
}

/** 把规则动作应用到一封邮件（经 ops → outbox） */
async function executeActions(userId: string, message: Message, rule: CompiledRule): Promise<void> {
  const db = await getDb();
  const [owned] = await loadOwnedMessages(userId, [message.id]);
  if (!owned) return;
  for (const action of rule.actions) {
    switch (action.type) {
      case "archive":
        await moveMessages(userId, [message.id], { role: "archive" });
        return; // 移出后后续动作无意义
      case "trash":
        await deleteMessages(userId, [message.id]);
        return;
      case "junk":
        await moveMessages(userId, [message.id], { role: "junk" });
        return;
      case "mark_read":
        await markMessages(userId, [message.id], { seen: true });
        break;
      case "mark_unread":
        await markMessages(userId, [message.id], { seen: false });
        break;
      case "flag":
        await markMessages(userId, [message.id], { flagged: true });
        break;
      case "label": {
        if (!action.value) break;
        const known = await db.query.folders.findMany({ where: eq(folders.accountId, owned.account.id) });
        if (!known.some((f) => f.path === action.value)) await enqueueRawOperation(owned.account.id, { type: "create_folder", folder: action.value }, []);
        await setGmailLabels(owned.account.id, owned.folder.path, [message.uid], [action.value]);
        break;
      }
      case "move": {
        if (!action.value) break;
        const target = action.value;
        const known = await db.query.folders.findMany({ where: eq(folders.accountId, owned.account.id) });
        const found = known.find((f) => f.path.toLowerCase() === target.toLowerCase() || f.name.toLowerCase() === target.toLowerCase());
        if (found) {
          await moveMessages(userId, [message.id], { folderId: found.id });
        } else {
          await enqueueRawOperation(owned.account.id, { type: "create_folder", folder: target }, []);
          await enqueueRawOperation(owned.account.id, { type: "move", folder: owned.folder.path, uids: [message.uid], toFolder: target }, [owned.folder.path, target]);
          await db.delete(messages).where(eq(messages.id, message.id));
        }
        return;
      }
    }
  }
}

/** 对一封邮件跑全部启用的规则，返回命中的规则名 */
export async function applyRulesToMessage(accountId: string, messageId: string): Promise<string[]> {
  const db = await getDb();
  const account = await db.query.mailAccounts.findFirst({ where: eq(mailAccounts.id, accountId) });
  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!account || !message) return [];
  const active = await db.query.rules.findMany({
    where: and(eq(rules.userId, account.userId), eq(rules.enabled, true), or(isNull(rules.accountId), eq(rules.accountId, accountId))),
    orderBy: [asc(rules.createdAt)],
  });
  if (active.length === 0) return [];
  const ai = await db.query.aiAnnotations.findFirst({ where: eq(aiAnnotations.messageId, messageId) });
  const ctx = messageContext(message, ai);
  const hits: string[] = [];
  for (const rule of active) {
    if (!evaluateRule(rule.compiled, ctx)) continue;
    hits.push(rule.name);
    await executeActions(account.userId, message, rule.compiled);
    await db
      .update(rules)
      .set({ runCount: rule.runCount + 1, lastRunAt: new Date() })
      .where(eq(rules.id, rule.id));
    if (rule.compiled.stopProcessing) break;
    // 邮件可能已被移出，后续规则不再处理
    const still = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
    if (!still) break;
  }
  if (hits.length) console.log(`[rules] ${account.email} 「${message.subject ?? ""}」命中：${hits.join("、")}`);
  return hits;
}

export interface RulePreviewItem {
  messageId: string;
  accountId: string;
  folderId: string;
  subject: string | null;
  from: string;
  date: string | null;
}

/** 在最近的收件箱邮件上试算规则（不执行动作） */
export async function previewRule(userId: string, compiled: CompiledRule, limit = 300): Promise<{ scanned: number; matches: RulePreviewItem[] }> {
  const db = await getDb();
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  if (accounts.length === 0) return { scanned: 0, matches: [] };
  const inboxes = await db.query.folders.findMany({ where: and(inArray(folders.accountId, accounts.map((a) => a.id)), eq(folders.role, "inbox")) });
  if (inboxes.length === 0) return { scanned: 0, matches: [] };
  const rows = await db
    .select({ message: messages, ai: aiAnnotations })
    .from(messages)
    .leftJoin(aiAnnotations, eq(aiAnnotations.messageId, messages.id))
    .where(inArray(messages.folderId, inboxes.map((f) => f.id)))
    .orderBy(desc(messages.date))
    .limit(limit);
  const matches = rows
    .filter(({ message, ai }) => evaluateRule(compiled, messageContext(message, ai)))
    .map(({ message: m }) => ({
      messageId: m.id,
      accountId: m.accountId,
      folderId: m.folderId,
      subject: m.subject,
      from: m.fromAddrs[0] ? m.fromAddrs[0].name || m.fromAddrs[0].address : "",
      date: m.date ? m.date.toISOString() : null,
    }));
  return { scanned: rows.length, matches };
}

/** 对已有邮件立即执行某条规则 */
export async function runRuleNow(userId: string, ruleId: string, limit = 300): Promise<number> {
  const db = await getDb();
  const rule = await db.query.rules.findFirst({ where: and(eq(rules.id, ruleId), eq(rules.userId, userId)) });
  if (!rule) throw new Error("规则不存在");
  const preview = await previewRule(userId, rule.compiled, limit);
  for (const m of preview.matches) {
    if (rule.accountId && rule.accountId !== m.accountId) continue;
    const message = await db.query.messages.findFirst({ where: eq(messages.id, m.messageId) });
    if (message) await executeActions(userId, message, rule.compiled);
  }
  await db
    .update(rules)
    .set({ runCount: rule.runCount + preview.matches.length, lastRunAt: new Date() })
    .where(eq(rules.id, ruleId));
  return preview.matches.length;
}

export async function listRules(userId: string): Promise<Rule[]> {
  const db = await getDb();
  return db.query.rules.findMany({ where: eq(rules.userId, userId), orderBy: [asc(rules.createdAt)] });
}

export async function createRule(userId: string, input: { naturalText: string; compiled: CompiledRule; accountId?: string | null }): Promise<Rule> {
  const db = await getDb();
  const [row] = await db
    .insert(rules)
    .values({ userId, accountId: input.accountId ?? null, name: input.compiled.name, naturalText: input.naturalText, compiled: input.compiled })
    .returning();
  return row;
}

export async function updateRule(userId: string, ruleId: string, patch: { enabled?: boolean; name?: string; compiled?: CompiledRule }): Promise<void> {
  const db = await getDb();
  await db
    .update(rules)
    .set({ ...patch })
    .where(and(eq(rules.id, ruleId), eq(rules.userId, userId)));
}

export async function deleteRule(userId: string, ruleId: string): Promise<void> {
  const db = await getDb();
  await db.delete(rules).where(and(eq(rules.id, ruleId), eq(rules.userId, userId)));
}
