"use server";

import type { ComposePayload } from "@/lib/api-types";
import { requireUser } from "@/server/auth/session";
import { deleteMessages, markMessages, moveMessages } from "@/server/mail/ops";
import { searchOnServer } from "@/server/mail/search";
import { saveDraft, sendMail } from "@/server/mail/send";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function markReadAction(ids: string[], seen: boolean) {
  return run(async () => {
    const user = await requireUser();
    await markMessages(user.id, ids, { seen });
  });
}

export async function flagAction(ids: string[], flagged: boolean) {
  return run(async () => {
    const user = await requireUser();
    await markMessages(user.id, ids, { flagged });
  });
}

export async function archiveAction(ids: string[]) {
  return run(async () => {
    const user = await requireUser();
    await moveMessages(user.id, ids, { role: "archive" });
  });
}

export async function junkAction(ids: string[]) {
  return run(async () => {
    const user = await requireUser();
    await moveMessages(user.id, ids, { role: "junk" });
  });
}

export async function notJunkAction(ids: string[]) {
  return run(async () => {
    const user = await requireUser();
    await moveMessages(user.id, ids, { role: "inbox" });
  });
}

export async function trashAction(ids: string[]) {
  return run(async () => {
    const user = await requireUser();
    await deleteMessages(user.id, ids);
  });
}

export async function moveAction(ids: string[], targetFolderId: string) {
  return run(async () => {
    const user = await requireUser();
    await moveMessages(user.id, ids, { folderId: targetFolderId });
  });
}

export async function sendMailAction(accountId: string, payload: ComposePayload) {
  return run(async () => {
    const user = await requireUser();
    return sendMail(user.id, accountId, payload);
  });
}

export async function saveDraftAction(accountId: string, payload: ComposePayload) {
  return run(async () => {
    const user = await requireUser();
    await saveDraft(user.id, accountId, payload);
  });
}

export async function searchOnServerAction(accountId: string, folderId: string, q: string) {
  return run(async () => {
    const user = await requireUser();
    return searchOnServer(user.id, accountId, folderId, q);
  });
}

// ---------- AI ----------

export async function aiDraftReplyAction(messageId: string, instructions?: string) {
  return run(async () => {
    const user = await requireUser();
    const { draftReply } = await import("@/server/ai/assist");
    return draftReply(user.id, messageId, instructions);
  });
}

export async function aiAnalyzeAction(messageId: string) {
  return run(async () => {
    const user = await requireUser();
    const { analyzeNow } = await import("@/server/ai/assist");
    const r = await analyzeNow(user.id, messageId);
    if (!r) throw new Error("无法分析这封邮件");
    return { category: r.category, priority: r.priority, summary: r.summary };
  });
}

export async function aiSummarizeAction(messageId: string) {
  return run(async () => {
    const user = await requireUser();
    const { summarizeMessage } = await import("@/server/ai/assist");
    return summarizeMessage(user.id, messageId);
  });
}

export async function refreshDigestAction(day: string) {
  return run(async () => {
    const user = await requireUser();
    const { dailyDigest } = await import("@/server/ai/assist");
    const r = await dailyDigest(user.id, day, { refresh: true });
    return { content: r.content };
  });
}
