import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { aiAnnotations, mailAccounts, messages } from "@/db/schema";
import { runRole } from "@/server/ai/client";
import { calendarEventsSchema, CALENDAR_EXTRACT_SYSTEM } from "@/server/ai/prompts";
import { createTask, type GoogleTask } from "./tasks";

/**
 * AI 从邮件中抽取「日程 / 待办」→ 供用户确认后写入 Google 任务（统一以任务承载，只用日期，不含时间；地点/时间点写入备注）。
 * 抽取是自动的，写入 Google 任务（外部副作用）保留用户确认步骤。
 */

export interface ScheduleCandidate {
  messageId: string;
  title: string;
  /** YYYY-MM-DD（截止日） */
  date: string;
  location: string | null;
  note: string | null;
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

export async function proposeCalendarEvents(userId: string, opts: { days?: number; limit?: number } = {}): Promise<{ candidates: ScheduleCandidate[]; model: string | null }> {
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
  const candidates: ScheduleCandidate[] = [];
  for (const e of parsed) {
    const messageId = String(e.messageId ?? "");
    const src = sources.get(messageId);
    const date = String(e.date ?? "").trim().slice(0, 10);
    const title = String(e.title ?? "").trim();
    if (!src || !title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    candidates.push({
      messageId,
      title,
      date,
      location: e.location ? String(e.location) : null,
      note: e.note ? String(e.note) : null,
      sourceSubject: src.subject,
      sourceFrom: src.from,
      accountId: src.accountId,
      folderId: src.folderId,
    });
  }
  return { candidates, model: r.model };
}

/** 把地点 / 时间点等合成任务备注 */
function toNotes(c: { location: string | null; note: string | null }): string | null {
  const parts = [c.note ?? "", c.location ? `📍 ${c.location}` : ""].map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

/** 把选中的候选写入 Google 任务（默认清单 @default，due=日期），返回成功创建的任务 */
export async function addScheduleAsTasks(userId: string, items: Array<{ title: string; date: string; location: string | null; note: string | null }>, listId = "@default"): Promise<{ created: GoogleTask[]; failed: number }> {
  const created: GoogleTask[] = [];
  let failed = 0;
  for (const c of items) {
    try {
      created.push(await createTask(userId, listId, { title: c.title, due: c.date, notes: toNotes(c) }));
    } catch {
      failed += 1;
    }
  }
  return { created, failed };
}
