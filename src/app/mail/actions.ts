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

/** 把邮件翻译成目标语言（结果缓存，可 refresh 重译） */
export async function translateMessageAction(messageId: string, lang: string, refresh = false) {
  return run(async () => {
    const user = await requireUser();
    const { translateMessage } = await import("@/server/ai/translate");
    return translateMessage(user.id, messageId, lang, { refresh });
  });
}

export async function semanticSearchAction(q: string, accountId?: string | null) {
  return run(async () => {
    const user = await requireUser();
    const { semanticSearch } = await import("@/server/ai/embeddings");
    return semanticSearch(user.id, q, { accountId, limit: 20 });
  });
}

export async function backfillEmbeddingsAction(limit: number) {
  return run(async () => {
    const user = await requireUser();
    const { backfillEmbeddings } = await import("@/server/ai/embeddings");
    return backfillEmbeddings(user.id, Math.min(Math.max(1, limit), 2000));
  });
}

export async function unsubscribeAction(messageId: string) {
  return run(async () => {
    const user = await requireUser();
    const { unsubscribe } = await import("@/server/mail/unsubscribe");
    return unsubscribe(user.id, messageId);
  });
}

/** 转给助手：把邮件归入各账号「Assistant」标签/文件夹，供 assistant 项目只读消费 */
export async function tagForAssistantAction(ids: string[]) {
  return run(async () => {
    const user = await requireUser();
    const { tagForAssistant } = await import("@/server/mail/ops");
    return tagForAssistant(user.id, ids);
  });
}

/** 给邮件打 Gmail 标签（非 Gmail 账号会被服务器拒绝，届时以服务器为准回同步） */
export async function labelAction(ids: string[], label: string) {
  return run(async () => {
    const user = await requireUser();
    const { loadOwnedMessages, setGmailLabels } = await import("@/server/mail/ops");
    const rows = await loadOwnedMessages(user.id, ids);
    const byFolder = new Map<string, { accountId: string; path: string; uids: number[] }>();
    for (const r of rows) {
      const key = r.folder.id;
      if (!byFolder.has(key)) byFolder.set(key, { accountId: r.account.id, path: r.folder.path, uids: [] });
      byFolder.get(key)!.uids.push(r.message.uid);
    }
    for (const g of byFolder.values()) await setGmailLabels(g.accountId, g.path, g.uids, [label]);
  });
}
