"use server";

import { requireUser } from "@/server/auth/session";
import { deleteThread, renameThread, sendChatMessage, type SendChatResult } from "@/server/ai/chat-store";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 在会话（threadId 为空则新建）里发送一条消息，返回 threadId 与本轮结果 */
export async function sendChatMessageAction(threadId: string | null, message: string): Promise<ActionResult<SendChatResult>> {
  return run(async () => {
    const user = await requireUser();
    return sendChatMessage(user.id, threadId, String(message).slice(0, 8000));
  });
}

export async function deleteThreadAction(threadId: string) {
  return run(async () => {
    const user = await requireUser();
    await deleteThread(user.id, threadId);
  });
}

export async function renameThreadAction(threadId: string, title: string) {
  return run(async () => {
    const user = await requireUser();
    await renameThread(user.id, threadId, title);
  });
}
