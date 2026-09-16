"use server";

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailAccounts, messages } from "@/db/schema";
import type { ComposePayload } from "@/lib/api-types";
import { formatAddrList, replySubject } from "@/lib/quote";
import type { DigestActionType } from "@/db/schema";
import { draftReply } from "@/server/ai/assist";
import { executeDispositions, generateDigest, markDispositionStatus, markRestNone, replanDigest, updateDisposition, type DigestKind, type RangeOptions } from "@/server/ai/digest";
import { requireUser } from "@/server/auth/session";
import { sendMail } from "@/server/mail/send";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 重新生成某个时间段的摘要与处理意见 */
export async function refreshDigestAction(kind: DigestKind, opts: RangeOptions) {
  return run(async () => {
    const user = await requireUser();
    // 前台按钮同步请求，限 40 封防超时；每日定时摘要（后台）不设限、分析全部
    const r = await generateDigest(user.id, kind, { ...opts, refresh: true, withPlan: true, analyze: true, analyzeCap: 40 });
    return { periodKey: r.range.periodKey, content: r.content, plan: r.plan, model: r.model, items: r.items };
  });
}

/** 用自然语言调整处理意见 */
export async function replanDigestAction(periodKey: string, instruction: string) {
  return run(async () => {
    const user = await requireUser();
    const text = instruction.trim();
    if (!text) throw new Error("请输入调整要求");
    const r = await replanDigest(user.id, periodKey, text);
    return { plan: r.plan };
  });
}

/** 确认后批量执行选中邮件的处理意见（reply 除外，reply 走回复流程） */
export async function executeDigestAction(periodKey: string, messageIds: string[]) {
  return run(async () => {
    const user = await requireUser();
    if (messageIds.length === 0) throw new Error("请先选择要处理的邮件");
    return executeDispositions(user.id, periodKey, messageIds);
  });
}

/** 手动修改单封邮件的处理动作 */
export async function updateDispositionAction(periodKey: string, messageId: string, action: DigestActionType, value?: string) {
  return run(async () => {
    const user = await requireUser();
    await updateDisposition(user.id, periodKey, messageId, { action, value: value ?? null });
  });
}

/** 其余全部标记无需处理：把所有未处理的意见一律设为 none */
export async function markRestNoneAction(periodKey: string) {
  return run(async () => {
    const user = await requireUser();
    return markRestNone(user.id, periodKey);
  });
}

/** 针对某封邮件，按我的主要意见生成回复草稿（不发送） */
export async function digestDraftReplyAction(messageId: string, points: string) {
  return run(async () => {
    const user = await requireUser();
    return draftReply(user.id, messageId, points);
  });
}

/** 发送回复（用户确认后），并把该邮件的处理意见标记为已处理 */
export async function digestSendReplyAction(periodKey: string, messageId: string, text: string) {
  return run(async () => {
    const user = await requireUser();
    const body = text.trim();
    if (!body) throw new Error("回复内容为空");
    const db = await getDb();
    const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
    if (!message) throw new Error("邮件不存在");
    const account = await db.query.mailAccounts.findFirst({ where: and(eq(mailAccounts.id, message.accountId), eq(mailAccounts.userId, user.id)) });
    if (!account) throw new Error("邮件不存在");

    const recipients = message.replyToAddrs.length ? message.replyToAddrs : message.fromAddrs;
    // 只发用户正文；引用（含原邮件富 HTML）由 sendMail 按 inReplyToMessageId 生成
    const payload: ComposePayload = {
      to: formatAddrList(recipients),
      subject: replySubject(message.subject),
      text: body,
      attachments: [],
      inReplyToMessageId: messageId,
    };
    const r = await sendMail(user.id, account.id, payload);
    await markDispositionStatus(user.id, periodKey, messageId, "done");
    return { messageId: r.messageId };
  });
}
