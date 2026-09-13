import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { aiAnnotations, mailAccounts, messages } from "@/db/schema";
import { CATEGORY_LABELS, type Category } from "./prompts";

/**
 * 待办面板：汇总 AI 从邮件里抽取的待办与「需要回复」的邮件。
 */

export interface TodoItem {
  messageId: string;
  accountId: string;
  folderId: string;
  subject: string | null;
  from: string;
  date: string | null;
  priority: string | null;
  categoryLabel: string;
  needsReply: boolean;
  items: Array<{ index: number; title: string; dueAt?: string; done?: boolean }>;
}

export async function listTodos(userId: string, days = 60): Promise<TodoItem[]> {
  const db = await getDb();
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  if (accounts.length === 0) return [];
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({ message: messages, ai: aiAnnotations })
    .from(messages)
    .innerJoin(aiAnnotations, eq(aiAnnotations.messageId, messages.id))
    .where(and(inArray(messages.accountId, accounts.map((a) => a.id)), gte(messages.date, since)))
    .orderBy(desc(messages.date));
  const order: Record<string, number> = { high: 0, normal: 1, low: 2 };
  return rows
    .map(({ message: m, ai }) => ({
      messageId: m.id,
      accountId: m.accountId,
      folderId: m.folderId,
      subject: m.subject,
      from: m.fromAddrs[0] ? m.fromAddrs[0].name || m.fromAddrs[0].address : "",
      date: m.date ? m.date.toISOString() : null,
      priority: ai.priority,
      categoryLabel: CATEGORY_LABELS[(ai.category ?? "other") as Category] ?? ai.category ?? "其他",
      needsReply: (ai.reason ?? "").includes("需要回复") && !m.answered,
      items: ai.actionItems.map((a, index) => ({ index, title: a.title, dueAt: a.dueAt, done: a.done })),
    }))
    .filter((t) => t.needsReply || t.items.length > 0)
    .sort((a, b) => (order[a.priority ?? "normal"] ?? 1) - (order[b.priority ?? "normal"] ?? 1));
}

export async function setTodoDone(userId: string, messageId: string, index: number, done: boolean): Promise<void> {
  const db = await getDb();
  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message) throw new Error("邮件不存在");
  const account = await db.query.mailAccounts.findFirst({ where: eq(mailAccounts.id, message.accountId) });
  if (!account || account.userId !== userId) throw new Error("邮件不存在");
  const ann = await db.query.aiAnnotations.findFirst({ where: eq(aiAnnotations.messageId, messageId) });
  if (!ann) return;
  const items = ann.actionItems.map((a, i) => (i === index ? { ...a, done } : a));
  await db.update(aiAnnotations).set({ actionItems: items }).where(eq(aiAnnotations.id, ann.id));
}
