import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { aiAnnotations, mailAccounts, messages } from "@/db/schema";
import { googleFetch } from "./api";

/**
 * Google 任务（Tasks API v1）：读写任务清单与任务。
 */

const BASE = "https://tasks.googleapis.com/tasks/v1";

/** @default 等特殊清单 id 不做 URL 编码，其余 id 正常编码 */
function encList(id: string): string {
  return id.startsWith("@") ? id : encodeURIComponent(id);
}

export interface TaskList {
  id: string;
  title: string;
}

export interface GoogleTask {
  id: string;
  title: string;
  notes: string | null;
  /** 截止日期：Google 只存日期（RFC3339，时间部分恒为 00:00Z） */
  due: string | null;
  completed: boolean;
  position: string | null;
}

interface RawTask {
  id: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: "needsAction" | "completed";
  position?: string;
}

function toTask(t: RawTask): GoogleTask {
  return {
    id: t.id,
    title: t.title ?? "(无标题)",
    notes: t.notes ?? null,
    due: t.due ?? null,
    completed: t.status === "completed",
    position: t.position ?? null,
  };
}

export async function listTaskLists(userId: string): Promise<TaskList[]> {
  const data = await googleFetch<{ items?: Array<{ id: string; title?: string }> }>(userId, `${BASE}/users/@me/lists?maxResults=100`);
  return (data.items ?? []).map((l) => ({ id: l.id, title: l.title ?? "(未命名清单)" }));
}

/** 默认清单（@default，即 Google 里的「我的任务」）的真实 id —— 摘要台「记为待办」也写这里 */
export async function getDefaultTaskListId(userId: string): Promise<string | null> {
  try {
    const l = await googleFetch<{ id: string }>(userId, `${BASE}/lists/@default`);
    return l.id;
  } catch {
    return null;
  }
}

/** 列出某清单下的任务（含已完成、隐藏项），按 position 排序 */
export async function listTasks(userId: string, taskListId: string): Promise<GoogleTask[]> {
  const params = new URLSearchParams({ showCompleted: "true", showHidden: "true", maxResults: "100" });
  const data = await googleFetch<{ items?: RawTask[] }>(userId, `${BASE}/lists/${encList(taskListId)}/tasks?${params.toString()}`);
  const tasks = (data.items ?? []).map(toTask);
  return tasks.sort((a, b) => (a.position ?? "").localeCompare(b.position ?? ""));
}

/** 带来源清单信息的任务（统一视图用） */
export interface TaskWithList extends GoogleTask {
  listId: string;
  listTitle: string;
}

/** 一次拉取**所有清单**的任务并合并（各清单并行拉取；某个失败则跳过） */
export async function listAllTasks(userId: string): Promise<{ lists: TaskList[]; tasks: TaskWithList[] }> {
  const lists = await listTaskLists(userId);
  const perList = await Promise.all(
    lists.map(async (l) => {
      try {
        return (await listTasks(userId, l.id)).map((t) => ({ ...t, listId: l.id, listTitle: l.title }));
      } catch {
        return [] as TaskWithList[];
      }
    }),
  );
  return { lists, tasks: perList.flat() };
}

export interface TaskInput {
  title: string;
  notes?: string | null;
  /** YYYY-MM-DD；不传表示无截止日 */
  due?: string | null;
}

export async function createTask(userId: string, taskListId: string, input: TaskInput): Promise<GoogleTask> {
  const body: Record<string, unknown> = { title: input.title };
  if (input.notes) body.notes = input.notes;
  if (input.due) body.due = `${input.due}T00:00:00.000Z`;
  const t = await googleFetch<RawTask>(userId, `${BASE}/lists/${encList(taskListId)}/tasks`, { method: "POST", body: JSON.stringify(body) });
  return toTask(t);
}

export async function updateTask(userId: string, taskListId: string, taskId: string, patch: Partial<TaskInput> & { completed?: boolean }): Promise<GoogleTask> {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.notes !== undefined) body.notes = patch.notes ?? "";
  if (patch.due !== undefined) body.due = patch.due ? `${patch.due}T00:00:00.000Z` : null;
  if (patch.completed !== undefined) body.status = patch.completed ? "completed" : "needsAction";
  const t = await googleFetch<RawTask>(userId, `${BASE}/lists/${encList(taskListId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return toTask(t);
}

export async function deleteTask(userId: string, taskListId: string, taskId: string): Promise<void> {
  await googleFetch(userId, `${BASE}/lists/${encList(taskListId)}/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
}

/**
 * 从一封邮件创建一条 Google 任务（默认清单 @default）：
 * 标题用主题、备注含发件人与 AI 摘要、截止日取 AI 待办里的 dueAt。摘要处理台执行「记为待办」时调用。
 */
export async function createTaskFromMessage(userId: string, messageId: string): Promise<GoogleTask> {
  const db = await getDb();
  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message) throw new Error("邮件不存在");
  const account = await db.query.mailAccounts.findFirst({ where: eq(mailAccounts.id, message.accountId) });
  if (!account || account.userId !== userId) throw new Error("邮件不存在");
  const ann = await db.query.aiAnnotations.findFirst({ where: eq(aiAnnotations.messageId, messageId) });
  const from = message.fromAddrs[0] ? message.fromAddrs[0].name || message.fromAddrs[0].address : "";
  const noteLines: string[] = [];
  if (from) noteLines.push(`发件人：${from}`);
  if (ann?.summary) noteLines.push(ann.summary);
  const dueRaw = ann?.actionItems.find((a) => a.dueAt)?.dueAt;
  const due = dueRaw && /^\d{4}-\d{2}-\d{2}/.test(dueRaw) ? dueRaw.slice(0, 10) : null;
  return createTask(userId, "@default", { title: message.subject || "(无主题)", notes: noteLines.join("\n") || null, due });
}
