import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { aiAnnotations, mailAccounts, messages } from "@/db/schema";
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

interface Source {
  subject: string | null;
  from: string;
  accountId: string;
  folderId: string;
  date: string | null;
  summary: string | null;
  actionItems: Array<{ title: string; dueAt?: string }>;
  snippet: string | null;
}

/** 候选来源：近 N 天里像有日程的邮件（重要/待办/账单类，或带 actionItems / 需回复） */
const EVENT_CATEGORIES = ["important", "todo", "billing", "personal", "notification"];

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
    .slice(0, opts.limit ?? 40);
  if (picked.length === 0) return { candidates: [], model: null };

  const sources = new Map<string, Source>();
  for (const { message: m, ai } of picked) {
    sources.set(m.id, {
      subject: m.subject,
      from: m.fromAddrs[0] ? m.fromAddrs[0].name || m.fromAddrs[0].address : "",
      accountId: m.accountId,
      folderId: m.folderId,
      date: m.date ? m.date.toISOString() : null,
      summary: ai.summary,
      actionItems: ai.actionItems,
      snippet: m.snippet,
    });
  }

  const list = [...sources.entries()]
    .map(([id, s], idx) => {
      const parts = [`${idx + 1}. id=${id}`, `发件人：${s.from}`, `主题：${s.subject ?? "(无主题)"}`, s.date ? `收件时间：${s.date}` : ""];
      if (s.summary) parts.push(`摘要：${s.summary}`);
      if (s.actionItems.length) parts.push(`待办：${s.actionItems.map((a) => `${a.title}${a.dueAt ? `(${a.dueAt})` : ""}`).join("；")}`);
      if (s.snippet) parts.push(`片段：${s.snippet.slice(0, 200)}`);
      return parts.filter(Boolean).join(" ｜ ");
    })
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
