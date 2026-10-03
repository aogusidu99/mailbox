import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { aiAnnotations, folders, mailAccounts, messages, rules, type CompiledRule, type Message, type Rule, type RuleAction, type RuleCondition } from "@/db/schema";
import { stripHtml } from "@/lib/quote";
import { deleteMessages, enqueueRawOperation, loadOwnedMessages, markMessages, moveMessages, setGmailLabels, tagForAssistant } from "@/server/mail/ops";
import { runRole } from "./client";

/**
 * 自然语言规则：用 rules 等级把「把所有发票邮件归档到 Finance」编译成结构化条件 + 动作，
 * 新邮件（拉取正文 / AI 分类后）逐条匹配并执行，动作经 outbox 同步到服务器。
 */

// schema 尽量宽容（兼容 DeepSeek 等非严格 JSON 厂商）：字段用 string + .catch 兜底，
// 真正的合法性校验放到 normalizeCompiled 里做（过滤非法项 + 友好报错）。
export const compiledRuleSchema = z.object({
  name: z.string().catch(""),
  match: z.enum(["all", "any"]).catch("all"),
  conditions: z
    .array(
      z.object({
        field: z.string().catch(""),
        op: z.string().catch(""),
        value: z.string().nullish(),
      }),
    )
    .catch([]),
  actions: z
    .array(
      z.object({
        type: z.string().catch(""),
        value: z.string().nullish(),
      }),
    )
    .catch([]),
  stopProcessing: z.boolean().nullish(),
});

const RULE_FIELDS = new Set<RuleCondition["field"]>(["from", "to", "subject", "body", "category", "priority", "hasAttachment", "needsReply", "listId"]);
const RULE_OPS = new Set<RuleCondition["op"]>(["contains", "not_contains", "equals", "starts_with", "ends_with", "matches", "is_true", "is_false"]);
const RULE_ACTIONS = new Set<RuleAction["type"]>(["archive", "trash", "mark_read", "mark_unread", "flag", "junk", "move", "label", "assistant"]);

// AI 有时用同义词 / 中文名，先归一到白名单再校验，避免把合法意图当成非法过滤掉（导致「没识别到动作/条件」）
const ACTION_ALIASES: Record<string, RuleAction["type"]> = {
  star: "flag", starred: "flag", 标星: "flag", 星标: "flag", 加星标: "flag",
  move_to: "move", moveto: "move", 移动: "move", 归档: "archive", 删除: "trash", delete: "trash",
  read: "mark_read", 已读: "mark_read", unread: "mark_unread", 未读: "mark_unread",
  spam: "junk", 垃圾: "junk", 垃圾邮件: "junk", tag: "label", 标签: "label", 助手: "assistant",
};
const FIELD_ALIASES: Record<string, RuleCondition["field"]> = {
  分类: "category", 类别: "category", category_label: "category", 优先级: "priority",
  发件人: "from", sender: "from", 收件人: "to", 主题: "subject", title: "subject", 正文: "body", 附件: "hasAttachment",
};

export const RULES_SYSTEM = `你是邮件规则编译器。把用户用自然语言描述的邮件处理规则，转换成结构化 JSON 规则。

可用字段（field）：from（发件人名字+地址）、to（收件人）、subject（主题）、body（正文摘要）、category（AI 分类：important/todo/notification/billing/newsletter/promotion/social/personal/other）、priority（AI 优先级：high/normal/low）、hasAttachment（是否有附件）、needsReply（AI 判断是否需要回复）、listId（邮件列表 ID，订阅类邮件常有）。
可用操作符（op）：contains / not_contains / equals / starts_with / ends_with / matches（正则）/ is_true / is_false（布尔字段用后两者，value 填 null）。
可用动作（type）：archive（归档）、trash（删除到已删除）、mark_read、mark_unread、flag（星标）、junk（垃圾邮件）、move（移动到文件夹，value 填文件夹名）、label（打 Gmail 标签，value 填标签名）、assistant（转给 AI 助手：把邮件归入「Assistant」标签/文件夹供助手读取，无需 value；用户说「转给助手 / 交给助理 / 让助手处理 / 同步给 assistant」时用它）。
规则：
- **每条规则必须同时输出非空的 conditions（针对哪些邮件）和 actions（做什么），两者缺一不可。**
- 每个动作是对象 {type, value}：type 只能是下列英文值之一——归档=archive、删除=trash、加星标/标星=flag、标为已读=mark_read、标为未读=mark_unread、标为垃圾=junk、移动到某文件夹=move、打 Gmail 标签=label、转给助手/交给助理=assistant。其中 move 的 value 填文件夹名、label 的 value 填标签名，其它动作 value 留空或省略。
- 「X 类」「X 类邮件」（X ∈ important/todo/notification/billing/newsletter/promotion/social/personal）一律写成 category equals X 条件——**即使动作里的文件夹名与类别同名（如把 promotion 类移到 Promotion 文件夹），也必须写出这个 category 条件**。
- 「重要」→ category equals important；「优先级高 / 紧急」→ priority equals high；两个条件可同时用（match=all）。
- 文本匹配不区分大小写；match 为 all 表示全部条件满足，any 表示任一满足。
- 用户说「发票 / 账单」等语义类别时，优先用 category 字段（billing 等），可再加 subject contains 作补充（此时 match=any）。
- name 用不超过 20 字的中文概括；stopProcessing 默认 false。`;

export type CompiledRuleInput = z.infer<typeof compiledRuleSchema>;

export function normalizeCompiled(input: CompiledRuleInput): CompiledRule {
  const conditions = input.conditions
    .map((c) => ({ ...c, field: FIELD_ALIASES[c.field] ?? c.field }))
    .filter((c) => RULE_FIELDS.has(c.field as RuleCondition["field"]) && RULE_OPS.has(c.op as RuleCondition["op"]))
    .map((c) => ({ field: c.field as RuleCondition["field"], op: c.op as RuleCondition["op"], value: c.value ?? undefined }))
    .slice(0, 8);
  const actions = input.actions
    .map((a) => ({ ...a, type: ACTION_ALIASES[a.type] ?? a.type }))
    .filter((a) => RULE_ACTIONS.has(a.type as RuleAction["type"]))
    .map((a) => ({ type: a.type as RuleAction["type"], value: a.value ?? undefined }))
    .slice(0, 5);
  if (actions.length === 0) {
    throw new Error("没识别到要执行的动作。规则是对每封邮件做动作（归档 / 星标 / 移动 / 删除 / 标记已读等），不是定时任务；请描述具体动作，例如「把发票邮件归档到 Finance」。");
  }
  if (conditions.length === 0) {
    throw new Error("没识别到匹配条件（发件人 / 主题 / 分类等），请更具体地描述这条规则针对哪些邮件。");
  }
  return { name: input.name || "规则", match: input.match, conditions, actions, stopProcessing: input.stopProcessing ?? false };
}

// 常见「某分类 → 某动作」规则的离线解析：稳定、免费、不依赖模型（模型抽风时的保底）
const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/推广|广告|促销|promotion/i, "promotion"],
  [/订阅|资讯|周报|newsletter/i, "newsletter"],
  [/账单|发票|billing/i, "billing"],
  [/社交|social/i, "social"],
  [/通知|notification/i, "notification"],
  [/待办|todo/i, "todo"],
  [/个人|personal/i, "personal"],
  [/重要|important/i, "important"],
];

/**
 * 确定模式的离线解析（仅限「分类/优先级 + 动作」这类清晰句式）。
 * 一旦句子里出现发件人/主题等"确定字段"信号，就返回 null 交给 AI——避免漏解析条件导致规则过宽。
 */
function parseRuleHeuristic(text: string): CompiledRule | null {
  const t = text.trim();
  if (!t) return null;
  if (/发件人|来自|收件人|主题|标题|正文|附件|邮件列表|包含|开头|结尾|正则/.test(t)) return null;

  const conditions: RuleCondition[] = [];
  for (const [re, cat] of CATEGORY_KEYWORDS) {
    if (re.test(t)) {
      conditions.push({ field: "category", op: "equals", value: cat });
      break;
    }
  }
  if (/优先级\s*高|高优先级|紧急/.test(t)) conditions.push({ field: "priority", op: "equals", value: "high" });
  else if (/优先级\s*低|低优先级/.test(t)) conditions.push({ field: "priority", op: "equals", value: "low" });

  const actions: RuleAction[] = [];
  const moveM = t.match(/(?:移动?[到至]|归入|归类到|放到|分到)\s*[「"']?([A-Za-z0-9一-龥_./-]+?)[」"']?\s*(?:文件夹|目录)?(?:$|[，。、；\s])/);
  if (moveM && moveM[1] && !/^(文件夹|目录)$/.test(moveM[1])) actions.push({ type: "move", value: moveM[1] });
  else if (/归档/.test(t)) actions.push({ type: "archive" });
  if (/加?星标|标星|打星/.test(t)) actions.push({ type: "flag" });
  if (/标为?已读|标记已读/.test(t)) actions.push({ type: "mark_read" });
  if (/标为?未读|标记未读/.test(t)) actions.push({ type: "mark_unread" });
  if (/垃圾邮件|标为?垃圾|标记垃圾/.test(t)) actions.push({ type: "junk" });
  else if (/删除/.test(t)) actions.push({ type: "trash" });
  if (/转给?助手|交给助理|让助手|同步给\s*assistant|转给\s*assistant/i.test(t)) actions.push({ type: "assistant" });

  if (conditions.length === 0 || actions.length === 0) return null;
  const name = (t.length <= 16 ? t : `${t.slice(0, 15)}…`).replace(/\s+/g, "");
  return { name, match: "all", conditions, actions: actions.slice(0, 5), stopProcessing: false };
}

/** 自然语言 → 结构化规则：先离线解析常见句式（稳），不行再用 AI（随机，带纠正提示最多重试 3 次）。 */
export async function compileRule(userId: string, naturalText: string): Promise<CompiledRule> {
  const heuristic = parseRuleHeuristic(naturalText);
  if (heuristic) return heuristic;
  let lastErr: unknown = new Error("规则编译失败");
  for (let attempt = 0; attempt < 3; attempt++) {
    const nudge =
      attempt === 0
        ? ""
        : "\n\n注意：上次没有给出有效的 conditions 或 actions。请确保 conditions（针对哪些邮件，如 category equals promotion）和 actions（做什么，如 move value=Promotion / flag）都非空。";
    const r = await runRole<CompiledRuleInput>({
      userId,
      role: "rules",
      schema: compiledRuleSchema,
      schemaName: "rule",
      maxTokens: 1024,
      messages: [
        { role: "system", content: RULES_SYSTEM },
        { role: "user", content: naturalText + nudge },
      ],
    });
    if (!r.json) {
      lastErr = new Error("AI 没有返回规则");
      continue;
    }
    try {
      return normalizeCompiled(r.json);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface BatchCompileResult {
  items: Array<{ naturalText: string; compiled: CompiledRule }>;
  errors: Array<{ line: string; error: string }>;
}

/** 批量编译：每行一条规则（空行、# / // 开头的注释行跳过），逐行编译，失败的单独收集不影响其它。 */
export async function compileRules(userId: string, text: string): Promise<BatchCompileResult> {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));
  if (lines.length === 0) throw new Error("请每行写一条规则");
  if (lines.length > 30) throw new Error("一次最多 30 条，请分批粘贴");
  const settled = await Promise.allSettled(lines.map((l) => compileRule(userId, l)));
  const items: BatchCompileResult["items"] = [];
  const errors: BatchCompileResult["errors"] = [];
  settled.forEach((res, i) => {
    if (res.status === "fulfilled") items.push({ naturalText: lines[i], compiled: res.value });
    else errors.push({ line: lines[i], error: res.reason instanceof Error ? res.reason.message : String(res.reason) });
  });
  return { items, errors };
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

// 强规则（确定规则）：条件不含 AI 分类/优先级/需回复，判断稳定，优先于 AI 规则执行
const AI_FIELDS = new Set<RuleCondition["field"]>(["category", "priority", "needsReply"]);
// 归位类动作：执行后邮件已被妥善安置，后续规则（含 AI 兜底）不该再重复处理这封
const FILING_ACTIONS = new Set<RuleAction["type"]>(["move", "archive", "trash", "junk"]);
export function isStrongRule(rule: CompiledRule): boolean {
  return rule.conditions.length > 0 && !rule.conditions.some((c) => AI_FIELDS.has(c.field));
}
function hasFilingAction(rule: CompiledRule): boolean {
  return rule.actions.some((a) => FILING_ACTIONS.has(a.type));
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
      case "assistant":
        await tagForAssistant(userId, [message.id]);
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
  // 强规则（确定规则）优先于 AI 分类规则；同层保持创建顺序（V8 稳定排序）
  const ordered = [...active].sort((a, b) => Number(isStrongRule(b.compiled)) - Number(isStrongRule(a.compiled)));
  const ai = await db.query.aiAnnotations.findFirst({ where: eq(aiAnnotations.messageId, messageId) });
  const ctx = messageContext(message, ai);
  const hits: string[] = [];
  for (const rule of ordered) {
    if (!evaluateRule(rule.compiled, ctx)) continue;
    hits.push(rule.name);
    await executeActions(account.userId, message, rule.compiled);
    await db
      .update(rules)
      .set({ runCount: rule.runCount + 1, lastRunAt: new Date() })
      .where(eq(rules.id, rule.id));
    // 强规则已把邮件归档/移动/删除/标垃圾 = 已处理完，AI 兜底规则不再对这封生效
    if (rule.compiled.stopProcessing || hasFilingAction(rule.compiled)) break;
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

/** 一次拉取最近收件箱邮件，对多条规则各自统计命中数（批量预览用，避免逐条重复扫描） */
export async function previewRules(userId: string, list: CompiledRule[], limit = 300): Promise<{ scanned: number; counts: number[] }> {
  const db = await getDb();
  if (list.length === 0) return { scanned: 0, counts: [] };
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  const inboxes = accounts.length
    ? await db.query.folders.findMany({ where: and(inArray(folders.accountId, accounts.map((a) => a.id)), eq(folders.role, "inbox")) })
    : [];
  if (inboxes.length === 0) return { scanned: 0, counts: list.map(() => 0) };
  const rows = await db
    .select({ message: messages, ai: aiAnnotations })
    .from(messages)
    .leftJoin(aiAnnotations, eq(aiAnnotations.messageId, messages.id))
    .where(inArray(messages.folderId, inboxes.map((f) => f.id)))
    .orderBy(desc(messages.date))
    .limit(limit);
  const ctxs = rows.map(({ message, ai }) => messageContext(message, ai));
  const counts = list.map((rule) => ctxs.filter((ctx) => evaluateRule(rule, ctx)).length);
  return { scanned: rows.length, counts };
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

/** 一键把**所有启用的规则**跑一遍存量邮件（每个账号最近 limit 封收件箱，按新邮件同样的逻辑逐封处理） */
export async function runAllRules(userId: string, limit = 300): Promise<{ scanned: number; applied: number }> {
  const db = await getDb();
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  if (accounts.length === 0) return { scanned: 0, applied: 0 };
  const inboxes = await db.query.folders.findMany({ where: and(inArray(folders.accountId, accounts.map((a) => a.id)), eq(folders.role, "inbox")) });
  if (inboxes.length === 0) return { scanned: 0, applied: 0 };
  const rows = await db
    .select({ id: messages.id, accountId: messages.accountId })
    .from(messages)
    .where(inArray(messages.folderId, inboxes.map((f) => f.id)))
    .orderBy(desc(messages.date))
    .limit(limit);
  let applied = 0;
  for (const m of rows) {
    const hits = await applyRulesToMessage(m.accountId, m.id).catch(() => [] as string[]);
    applied += hits.length;
  }
  return { scanned: rows.length, applied };
}

export interface RuleSuggestion {
  compiled: CompiledRule;
  reason: string;
}

/**
 * 从「邮件现在都分到哪了」归纳强规则：某发件人的邮件大多进了某个用户文件夹（且往往还有漏网在收件箱）
 * → 建议按**发件人**建一条强规则，把这类邮件都稳定归过去（补 AI 分类的漏）。确定性分析，不走模型。
 */
export async function suggestStrongRules(userId: string, limit = 2000): Promise<RuleSuggestion[]> {
  const db = await getDb();
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  if (accounts.length === 0) return [];
  const accIds = accounts.map((a) => a.id);
  const allFolders = await db.query.folders.findMany({ where: inArray(folders.accountId, accIds) });
  const folderById = new Map(allFolders.map((f) => [f.id, f]));
  const rows = await db
    .select({ from: messages.fromAddrs, folderId: messages.folderId })
    .from(messages)
    .where(inArray(messages.accountId, accIds))
    .orderBy(desc(messages.date))
    .limit(limit);

  type Stat = { total: number; inbox: number; byFolder: Map<string, number>; display: string };
  const bySender = new Map<string, Stat>();
  for (const r of rows) {
    const a0 = r.from?.[0];
    const addr = a0?.address?.toLowerCase();
    if (!addr) continue;
    const f = folderById.get(r.folderId);
    if (!f || (f.role && f.role !== "inbox")) continue; // 只看收件箱 + 用户文件夹（忽略 已发送/草稿/垃圾/归档）
    let s = bySender.get(addr);
    if (!s) {
      s = { total: 0, inbox: 0, byFolder: new Map(), display: a0.name || addr };
      bySender.set(addr, s);
    }
    s.total += 1;
    if (f.role === "inbox") s.inbox += 1;
    else s.byFolder.set(f.name, (s.byFolder.get(f.name) ?? 0) + 1);
  }

  const existing = await db.query.rules.findMany({ where: eq(rules.userId, userId) });
  const out: Array<RuleSuggestion & { strays: number }> = [];
  for (const [addr, s] of bySender) {
    if (s.total < 3) continue;
    let folder = "";
    let cnt = 0;
    for (const [name, c] of s.byFolder) {
      if (c > cnt) {
        folder = name;
        cnt = c;
      }
    }
    if (!folder || cnt < 2 || cnt / s.total < 0.5) continue; // 主流去向明确才建议
    const covered = existing.some(
      (r) =>
        r.compiled.actions.some((a) => a.type === "move" && (a.value ?? "").toLowerCase() === folder.toLowerCase()) &&
        r.compiled.conditions.some((c) => c.field === "from" && (c.value ?? "") !== "" && addr.includes((c.value ?? "").toLowerCase())),
    );
    if (covered) continue;
    out.push({
      strays: s.inbox,
      compiled: { name: `${s.display}→${folder}`.slice(0, 20), match: "all", conditions: [{ field: "from", op: "contains", value: addr }], actions: [{ type: "move", value: folder }], stopProcessing: false },
      reason: `${s.display} <${addr}>：共 ${s.total} 封，${cnt} 封在「${folder}」${s.inbox ? `、还有 ${s.inbox} 封漏在收件箱` : ""} → 发件人含 ${addr} → 移动到 ${folder}`,
    });
  }
  // 漏网多的排前面（最该补规则）
  out.sort((a, b) => b.strays - a.strays || 0);
  return out.slice(0, 20).map(({ compiled, reason }) => ({ compiled, reason }));
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

/** 批量创建规则（批量导入用） */
export async function createRules(userId: string, items: Array<{ naturalText: string; compiled: CompiledRule }>, accountId?: string | null): Promise<number> {
  if (items.length === 0) return 0;
  const db = await getDb();
  await db.insert(rules).values(items.map((it) => ({ userId, accountId: accountId ?? null, name: it.compiled.name, naturalText: it.naturalText, compiled: it.compiled })));
  return items.length;
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
