import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { aiAnnotations, aiDigests, mailAccounts, messages } from "@/db/schema";
import { runRole } from "./client";
import { CATEGORY_LABELS, DIGEST_SYSTEM, DRAFT_SYSTEM, messageToPromptText, SUMMARY_SYSTEM, type Category } from "./prompts";
import { triageMessage } from "./triage";

/**
 * 面向用户的 AI 助手功能：回复起草、按需摘要、每日摘要。
 */

async function loadOwned(userId: string, messageId: string) {
  const db = await getDb();
  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message) throw new Error("邮件不存在");
  const account = await db.query.mailAccounts.findFirst({ where: and(eq(mailAccounts.id, message.accountId), eq(mailAccounts.userId, userId)) });
  if (!account) throw new Error("邮件不存在");
  if (!message.bodyFetchedAt) {
    const { ensureMessageBody } = await import("@/server/sync/engine");
    const updated = await ensureMessageBody(messageId);
    return { message: updated ?? message, account };
  }
  return { message, account };
}

/** 回复起草（draft 等级） */
export async function draftReply(userId: string, messageId: string, instructions?: string): Promise<{ text: string; model: string }> {
  const { message, account } = await loadOwned(userId, messageId);
  const user = [
    "下面是需要回复的原邮件：",
    "-----",
    messageToPromptText(message, 8000),
    "-----",
    `我的邮箱：${account.displayName ? `${account.displayName} <${account.email}>` : account.email}`,
    instructions?.trim() ? `我的要求：${instructions.trim()}` : "我的要求：按常规礼貌回复，确认收到并回应对方提出的要点。",
  ].join("\n");
  const r = await runRole({
    userId,
    accountId: account.id,
    role: "draft",
    maxTokens: 2048,
    messages: [
      { role: "system", content: DRAFT_SYSTEM },
      { role: "user", content: user },
    ],
  });
  return { text: r.text.trim(), model: r.model };
}

/** 立即分析一封邮件（无视账号开关） */
export async function analyzeNow(userId: string, messageId: string) {
  const { message } = await loadOwned(userId, messageId);
  return triageMessage(message.accountId, messageId, { force: true });
}

/** 会话 / 长邮件摘要（summary 等级），不入库 */
export async function summarizeMessage(userId: string, messageId: string): Promise<{ text: string; model: string }> {
  const { message, account } = await loadOwned(userId, messageId);
  const r = await runRole({
    userId,
    accountId: account.id,
    role: "summary",
    maxTokens: 1024,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: `请用 3–5 个要点总结这封邮件，并指出需要我做什么：\n\n${messageToPromptText(message, 12000)}` },
    ],
  });
  return { text: r.text.trim(), model: r.model };
}

export interface DigestItem {
  messageId: string;
  accountId: string;
  folderId: string;
  subject: string | null;
  from: string;
  date: string | null;
  category: string | null;
  categoryLabel: string;
  priority: string | null;
  summary: string | null;
  actionItems: Array<{ title: string; dueAt?: string }>;
  needsReply: boolean;
}

function dayRange(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start.getTime() + 86_400_000);
  return { start, end };
}

export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 某天的已标注邮件清单 */
export async function digestItems(userId: string, day: string): Promise<DigestItem[]> {
  const db = await getDb();
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  if (accounts.length === 0) return [];
  const { start, end } = dayRange(day);
  const rows = await db
    .select({ message: messages, ai: aiAnnotations })
    .from(messages)
    .innerJoin(aiAnnotations, eq(aiAnnotations.messageId, messages.id))
    .where(and(inArray(messages.accountId, accounts.map((a) => a.id)), gte(messages.date, start), lt(messages.date, end)))
    .orderBy(messages.date);
  const order: Record<string, number> = { high: 0, normal: 1, low: 2 };
  return rows
    .map(({ message: m, ai }) => ({
      messageId: m.id,
      accountId: m.accountId,
      folderId: m.folderId,
      subject: m.subject,
      from: m.fromAddrs[0] ? m.fromAddrs[0].name || m.fromAddrs[0].address : "",
      date: m.date ? m.date.toISOString() : null,
      category: ai.category,
      categoryLabel: CATEGORY_LABELS[(ai.category ?? "other") as Category] ?? ai.category ?? "其他",
      priority: ai.priority,
      summary: ai.summary,
      actionItems: ai.actionItems,
      needsReply: (ai.reason ?? "").includes("需要回复"),
    }))
    .sort((a, b) => (order[a.priority ?? "normal"] ?? 1) - (order[b.priority ?? "normal"] ?? 1));
}

/** 生成（或读取缓存的）每日摘要文本 */
export async function dailyDigest(userId: string, day: string, opts: { refresh?: boolean } = {}): Promise<{ items: DigestItem[]; content: string | null; model?: string; cached: boolean }> {
  const db = await getDb();
  const items = await digestItems(userId, day);
  if (!opts.refresh) {
    const cached = await db.query.aiDigests.findFirst({ where: and(eq(aiDigests.userId, userId), eq(aiDigests.day, day)) });
    if (cached) return { items, content: cached.content, model: cached.model, cached: true };
  }
  if (items.length === 0) return { items, content: null, cached: false };
  const list = items
    .map(
      (i, idx) =>
        `${idx + 1}. [${i.categoryLabel}/${i.priority}${i.needsReply ? "/需回复" : ""}] ${i.from}：${i.subject ?? "(无主题)"} — ${i.summary ?? ""}${
          i.actionItems.length ? ` 待办：${i.actionItems.map((a) => `${a.title}${a.dueAt ? `（${a.dueAt}）` : ""}`).join("；")}` : ""
        }`,
    )
    .join("\n");
  const r = await runRole({
    userId,
    role: "summary",
    maxTokens: 2048,
    messages: [
      { role: "system", content: DIGEST_SYSTEM },
      { role: "user", content: `日期：${day}\n共 ${items.length} 封邮件：\n${list}` },
    ],
  });
  await db
    .insert(aiDigests)
    .values({ userId, day, content: r.text.trim(), model: r.model })
    .onConflictDoUpdate({ target: [aiDigests.userId, aiDigests.day], set: { content: r.text.trim(), model: r.model, createdAt: new Date() } });
  return { items, content: r.text.trim(), model: r.model, cached: false };
}
