import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailAccounts, messages } from "@/db/schema";
import { runRole } from "./client";
import { DRAFT_SYSTEM, messageToPromptText, SUMMARY_SYSTEM } from "./prompts";
import { triageMessage } from "./triage";

/**
 * 面向用户的 AI 助手功能：回复起草、按需摘要、立即分析。
 * 每日/时间段摘要与处理意见见 ./digest.ts。
 */

async function loadOwned(userId: string, messageId: string) {
  const db = await getDb();
  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message) throw new Error("邮件不存在");
  const account = await db.query.mailAccounts.findFirst({ where: and(eq(mailAccounts.id, message.accountId), eq(mailAccounts.userId, userId)) });
  if (!account) throw new Error("邮件不存在");
  if (!message.bodyFetchedAt) {
    const { ensureMessageBody } = await import("@/server/sync/engine");
    const updated = await ensureMessageBody(messageId);
    return { message: updated ?? message, account };
  }
  return { message, account };
}

/** 回复起草（draft 等级） */
export async function draftReply(userId: string, messageId: string, instructions?: string): Promise<{ text: string; model: string }> {
  const { message, account } = await loadOwned(userId, messageId);
  const user = [
    "下面是需要回复的原邮件：",
    "-----",
    messageToPromptText(message, 8000),
    "-----",
    `我的邮箱：${account.displayName ? `${account.displayName} <${account.email}>` : account.email}`,
    instructions?.trim() ? `我的要求：${instructions.trim()}` : "我的要求：按常规礼貌回复，确认收到并回应对方提出的要点。",
  ].join("\n");
  const r = await runRole({
    userId,
    accountId: account.id,
    role: "draft",
    maxTokens: 2048,
    messages: [
      { role: "system", content: DRAFT_SYSTEM },
      { role: "user", content: user },
    ],
  });
  return { text: r.text.trim(), model: r.model };
}

/** 立即分析一封邮件（无视账号开关） */
export async function analyzeNow(userId: string, messageId: string) {
  const { message } = await loadOwned(userId, messageId);
  return triageMessage(message.accountId, messageId, { force: true });
}

/** 会话 / 长邮件摘要（summary 等级），不入库 */
export async function summarizeMessage(userId: string, messageId: string): Promise<{ text: string; model: string }> {
  const { message, account } = await loadOwned(userId, messageId);
  const r = await runRole({
    userId,
    accountId: account.id,
    role: "summary",
    maxTokens: 1024,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: `请用 3–5 个要点总结这封邮件，并指出需要我做什么：\n\n${messageToPromptText(message, 12000)}` },
    ],
  });
  return { text: r.text.trim(), model: r.model };
}
