import { and, desc, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { aiAnnotations, mailAccounts, messages } from "@/db/schema";
import { stripHtml } from "@/lib/quote";
import { runRole } from "@/server/ai/client";
import { calendarEventsSchema, CALENDAR_EXTRACT_SYSTEM } from "@/server/ai/prompts";
import { createEvent, type CalEvent, type CalEventInput } from "./calendar";

/**
 * AI 从邮件中抽取「日程」（会议/预约等，带时间）→ 供用户确认后加入 Google 日历（真实事件）。
 * 抽取是自动的，写入日历（外部副作用）保留用户确认步骤。
 */

export interface EventCandidate extends CalEventInput {
  messageId: string;
  /** 来源邮件信息（展示用） */
  sourceSubject: string | null;
  sourceFrom: string;
  accountId: string;
  folderId: string;
}

/** 送给模型抽取的单封邮件：元信息 + 内容（近 N 天模式用摘要/片段，指定邮件模式用完整正文） */
interface PickedSource {
  id: string;
  subject: string | null;
  from: string;
  accountId: string;
  folderId: string;
  date: string | null;
  content: string;
}

/** 候选来源：近 N 天里像有日程的邮件（重要/待办/账单类，或带 actionItems / 需回复） */
const EVENT_CATEGORIES = ["important", "todo", "billing", "personal", "notification"];
const MAX_PICK_MESSAGES = 20;

/** 共用：把一批邮件送给模型抽取带时间的日程候选 */
async function runExtract(userId: string, picked: PickedSource[]): Promise<{ candidates: EventCandidate[]; model: string | null }> {
  if (picked.length === 0) return { candidates: [], model: null };
  const sources = new Map(picked.map((p) => [p.id, p]));
  const list = picked
    .map((p, idx) => [`${idx + 1}. id=${p.id}`, `发件人：${p.from}`, `主题：${p.subject ?? "(无主题)"}`, p.date ? `收件时间：${p.date}` : "", p.content ? `内容：${p.content}` : ""].filter(Boolean).join(" ｜ "))
    .join("\n");

  const r = await runRole({
    userId,
    role: "extract",
    maxTokens: 3072,
    schema: calendarEventsSchema,
    schemaName: "calendar_events",
    messages: [
      { role: "system", content: CALENDAR_EXTRACT_SYSTEM },
      { role: "user", content: `当前时间：${new Date().toISOString()}\n\n邮件清单：\n${list}` },
    ],
  });

  const parsed = (r.json as { events?: Array<Record<string, unknown>> } | undefined)?.events ?? [];
  const candidates: EventCandidate[] = [];
  for (const e of parsed) {
    const messageId = String(e.messageId ?? "");
    const src = sources.get(messageId);
    const start = String(e.start ?? "").trim();
    const title = String(e.title ?? "").trim();
    if (!src || !start || !title) continue;
    candidates.push({
      messageId,
      title,
      start,
      end: e.end ? String(e.end) : null,
      allDay: Boolean(e.allDay),
      location: e.location ? String(e.location) : null,
      description: e.description ? String(e.description) : null,
      sourceSubject: src.subject,
      sourceFrom: src.from,
      accountId: src.accountId,
      folderId: src.folderId,
    });
  }
  return { candidates, model: r.model };
}

const fromName = (m: { fromAddrs: Array<{ name?: string; address: string }> }) => (m.fromAddrs[0] ? m.fromAddrs[0].name || m.fromAddrs[0].address : "");

/** 近 N 天自动挑选像有日程的邮件抽取（用 AI 分类的摘要/待办/片段作为内容） */
export async function proposeCalendarEvents(userId: string, opts: { days?: number; limit?: number } = {}): Promise<{ candidates: EventCandidate[]; model: string | null }> {
  const db = await getDb();
  const days = opts.days ?? 14;
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  if (accounts.length === 0) return { candidates: [], model: null };
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({ message: messages, ai: aiAnnotations })
    .from(messages)
    .innerJoin(aiAnnotations, eq(aiAnnotations.messageId, messages.id))
    .where(and(inArray(messages.accountId, accounts.map((a) => a.id)), gte(messages.date, since)))
    .orderBy(desc(messages.date));

  const picked = rows
    .filter(({ ai }) => EVENT_CATEGORIES.includes(ai.category ?? "") || ai.actionItems.some((a) => a.dueAt) || (ai.reason ?? "").includes("需要回复"))
    .slice(0, opts.limit ?? 40)
    .map<PickedSource>(({ message: m, ai }) => {
      const content = [ai.summary, ai.actionItems.length ? `待办：${ai.actionItems.map((a) => `${a.title}${a.dueAt ? `(${a.dueAt})` : ""}`).join("；")}` : "", m.snippet?.slice(0, 200)].filter(Boolean).join(" / ");
      return { id: m.id, subject: m.subject, from: fromName(m), accountId: m.accountId, folderId: m.folderId, date: m.date ? m.date.toISOString() : null, content };
    });
  return runExtract(userId, picked);
}

/** 从**指定的邮件**抽取日程（用**完整正文**，更准）——供邮件界面「提取日程」与日历页「选择邮件」用 */
export async function proposeCalendarEventsFromMessages(userId: string, messageIds: string[]): Promise<{ candidates: EventCandidate[]; model: string | null }> {
  const db = await getDb();
  const ids = messageIds.slice(0, MAX_PICK_MESSAGES);
  if (ids.length === 0) return { candidates: [], model: null };
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  const accountIds = new Set(accounts.map((a) => a.id));
  const rows = await db.query.messages.findMany({ where: inArray(messages.id, ids) });
  const picked: PickedSource[] = [];
  for (const m of rows) {
    if (!accountIds.has(m.accountId)) continue; // 只处理本人邮件
    let msg = m;
    if (!m.bodyFetchedAt) {
      const { ensureMessageBody } = await import("@/server/sync/engine");
      msg = (await ensureMessageBody(m.id).catch(() => null)) ?? m;
    }
    const content = (msg.textBody?.trim() || (msg.htmlBody ? stripHtml(msg.htmlBody, 6000) : "") || msg.snippet || "").slice(0, 3500);
    picked.push({ id: msg.id, subject: msg.subject, from: fromName(msg), accountId: msg.accountId, folderId: msg.folderId, date: msg.date ? msg.date.toISOString() : null, content });
  }
  return runExtract(userId, picked);
}

export interface PickMessage {
  id: string;
  subject: string | null;
  from: string;
  date: string | null;
}

/** 供日历页「选择邮件」的邮件清单：按主题 / 发件人 / 片段搜索，按时间倒序 */
export async function listCandidateMessages(userId: string, opts: { query?: string; limit?: number } = {}): Promise<PickMessage[]> {
  const db = await getDb();
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  if (accounts.length === 0) return [];
  const conds: SQL[] = [inArray(messages.accountId, accounts.map((a) => a.id))];
  const q = opts.query?.trim();
  if (q) {
    const term = `%${q}%`;
    conds.push(or(ilike(messages.subject, term), sql`${messages.fromAddrs}::text ilike ${term}`, ilike(messages.snippet, term)) as SQL);
  }
  const rows = await db
    .select()
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.date))
    .limit(Math.min(opts.limit ?? 30, 50));
  return rows.map((m) => ({ id: m.id, subject: m.subject, from: fromName(m), date: m.date ? m.date.toISOString() : null }));
}

/** 把选中的候选事件写入 Google 日历（主日历），返回成功创建的事件 */
export async function addEventsToCalendar(userId: string, events: CalEventInput[]): Promise<{ created: CalEvent[]; failed: number }> {
  const created: CalEvent[] = [];
  let failed = 0;
  for (const e of events) {
    try {
      created.push(await createEvent(userId, e));
    } catch {
      failed += 1;
    }
  }
  return { created, failed };
}
