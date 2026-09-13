"use server";

import { chatTurn, type ChatHistoryItem } from "@/server/ai/agent";
import { requireUser } from "@/server/auth/session";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

export async function chatTurnAction(history: ChatHistoryItem[], message: string): Promise<ActionResult<Awaited<ReturnType<typeof chatTurn>>>> {
  try {
    const user = await requireUser();
    const text = message.trim();
    if (!text) throw new Error("请输入问题");
    const safeHistory = history.slice(-20).map((h) => ({ role: h.role === "assistant" ? ("assistant" as const) : ("user" as const), content: String(h.content).slice(0, 8000) }));
    return { ok: true, data: await chatTurn(user.id, safeHistory, text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
