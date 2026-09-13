import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages, chatThreads } from "@/db/schema";
import { chatTurn, type ChatHistoryItem, type ChatProposal, type ChatTrace, type ChatTurnResult } from "./agent";

/**
 * 「和邮箱对话」历史持久化：会话（chat_threads）+ 逐条消息（chat_messages）。
 * chatTurn 本身保持无状态，这里负责加载历史、跑一轮、落库。
 */

export interface StoredTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  proposals?: ChatProposal[];
  trace?: ChatTrace[];
  model?: string;
  createdAt: string;
}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
}

function titleFrom(message: string): string {
  const t = message.trim().replace(/\s+/g, " ");
  return t.length > 30 ? `${t.slice(0, 30)}…` : t || "新对话";
}

export async function listThreads(userId: string): Promise<ThreadSummary[]> {
  const db = await getDb();
  const rows = await db.query.chatThreads.findMany({ where: eq(chatThreads.userId, userId), orderBy: [desc(chatThreads.updatedAt)], limit: 100 });
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
}

/** 返回会话内的消息；会话不存在或不属于该用户时返回 null */
export async function getThreadMessages(userId: string, threadId: string): Promise<StoredTurn[] | null> {
  const db = await getDb();
  const thread = await db.query.chatThreads.findFirst({ where: and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)) });
  if (!thread) return null;
  const rows = await db.query.chatMessages.findMany({ where: eq(chatMessages.threadId, threadId), orderBy: [asc(chatMessages.createdAt)] });
  return rows.map((r) => ({
    id: r.id,
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.content,
    proposals: (r.proposals as ChatProposal[] | null) ?? undefined,
    trace: (r.trace as ChatTrace[] | null) ?? undefined,
    model: r.model ?? undefined,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function deleteThread(userId: string, threadId: string): Promise<void> {
  const db = await getDb();
  await db.delete(chatThreads).where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
}

export async function renameThread(userId: string, threadId: string, title: string): Promise<void> {
  const db = await getDb();
  const clean = title.trim().slice(0, 80) || "新对话";
  await db.update(chatThreads).set({ title: clean }).where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
}

export interface SendChatResult {
  threadId: string;
  turn: ChatTurnResult;
}

/** 在指定会话（或新建会话）里发送一条消息，跑一轮 Agent 并把用户/助手消息落库。 */
export async function sendChatMessage(userId: string, threadId: string | null, message: string): Promise<SendChatResult> {
  const db = await getDb();
  const text = message.trim();
  if (!text) throw new Error("请输入问题");

  let id = threadId;
  let history: ChatHistoryItem[] = [];
  if (id) {
    const existing = await getThreadMessages(userId, id);
    if (existing === null) throw new Error("会话不存在");
    history = existing.slice(-20).map((m) => ({ role: m.role, content: m.content }));
  } else {
    const [created] = await db.insert(chatThreads).values({ userId, title: titleFrom(text) }).returning({ id: chatThreads.id });
    id = created.id;
  }

  const turn = await chatTurn(userId, history, text);

  await db.insert(chatMessages).values([
    { threadId: id, role: "user", content: text },
    {
      threadId: id,
      role: "assistant",
      content: turn.reply,
      proposals: turn.proposals.length ? (turn.proposals as unknown as Record<string, unknown>[]) : null,
      trace: turn.trace.length ? (turn.trace as unknown as Record<string, unknown>[]) : null,
      model: turn.model,
    },
  ]);
  // 刷新会话的更新时间（用于列表排序）
  await db.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, id));

  return { threadId: id, turn };
}
