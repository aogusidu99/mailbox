import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { attachments, mailAccounts, messages, type EmailAddress } from "@/db/schema";
import type { ComposePayload } from "@/lib/api-types";
import { withProvider } from "@/server/providers/factory";
import { describeImapError } from "@/server/providers/imap";
import { getPreset, type PresetId } from "@/server/providers/presets";
import { buildMime, parseAddressList, removeUpload, type ComposeAttachmentInput } from "./compose";
import { appendToRoleFolder, deleteMessageHard, markAnswered } from "./ops";
import { getAttachmentContent } from "./queries";

/**
 * 发送 / 存草稿。发送走 SMTP 同步完成（用户立刻得到结果）；
 * 已发送副本与草稿通过 outbox APPEND 到服务器，手机等其它客户端也能看到。
 */

async function loadAccount(userId: string, accountId: string) {
  const db = await getDb();
  const account = await db.query.mailAccounts.findFirst({ where: eq(mailAccounts.id, accountId) });
  if (!account || account.userId !== userId) throw new Error("账号不存在");
  return account;
}

async function resolveThreadHeaders(messageId: string | undefined): Promise<{ inReplyTo?: string; references?: string[] }> {
  if (!messageId) return {};
  const db = await getDb();
  const original = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!original?.messageId) return {};
  const prev = original.headers?.["references"];
  const refs = (Array.isArray(prev) ? prev.join(" ") : (prev ?? "")).match(/<[^>]+>/g) ?? [];
  return { inReplyTo: original.messageId, references: [...refs, original.messageId].slice(-30) };
}

async function forwardedAttachments(userId: string, messageId: string | undefined): Promise<ComposeAttachmentInput[]> {
  if (!messageId) return [];
  const db = await getDb();
  const atts = await db.query.attachments.findMany({ where: eq(attachments.messageId, messageId) });
  const out: ComposeAttachmentInput[] = [];
  for (const a of atts) {
    if (a.inline && a.contentId) continue;
    const c = await getAttachmentContent(userId, a.id);
    if (c) out.push({ filename: c.filename, mimeType: c.mimeType, content: c.content });
  }
  return out;
}

function composeInput(payload: ComposePayload, from: EmailAddress, thread: { inReplyTo?: string; references?: string[] }, extra: ComposeAttachmentInput[]) {
  const to = parseAddressList(payload.to);
  return {
    from,
    to,
    cc: parseAddressList(payload.cc),
    bcc: parseAddressList(payload.bcc),
    subject: payload.subject.trim(),
    text: payload.text,
    inReplyTo: thread.inReplyTo,
    references: thread.references,
    attachments: [
      ...payload.attachments.map<ComposeAttachmentInput>((a) => ({ uploadId: a.id, filename: a.filename, mimeType: a.mimeType })),
      ...extra,
    ],
  };
}

/**
 * 回复时决定是否把自己加入 BCC：仅当账号开启该设置且这是一封回复（有 inReplyToMessageId）；
 * 若自己已在收件人（to/cc/bcc）里则不重复添加。返回要追加到 bcc 的地址，或 null。
 */
export function bccSelfAddress(opts: {
  enabled: boolean;
  isReply: boolean;
  selfEmail: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
}): EmailAddress | null {
  if (!opts.enabled || !opts.isReply) return null;
  const self = opts.selfEmail.toLowerCase();
  const already = [...opts.to, ...(opts.cc ?? []), ...(opts.bcc ?? [])].some((a) => a.address.toLowerCase() === self);
  return already ? null : { address: opts.selfEmail };
}

export async function sendMail(userId: string, accountId: string, payload: ComposePayload): Promise<{ messageId: string }> {
  const account = await loadAccount(userId, accountId);
  const from: EmailAddress = { name: account.displayName ?? undefined, address: account.email };
  const thread = await resolveThreadHeaders(payload.inReplyToMessageId);
  const extra = payload.forwardOfMessageId && payload.includeOriginalAttachments ? await forwardedAttachments(userId, payload.forwardOfMessageId) : [];
  const input = composeInput(payload, from, thread, extra);
  // 回复时按账号设置自动密送一份给自己（BCC 不进邮件头，收件人看不到）
  const selfBcc = bccSelfAddress({
    enabled: account.bccSelfOnReply,
    isReply: Boolean(payload.inReplyToMessageId),
    selfEmail: account.email,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
  });
  if (selfBcc) input.bcc = [...(input.bcc ?? []), selfBcc];
  if (input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0) === 0) throw new Error("请至少填写一个收件人");

  const { mime, messageId } = await buildMime(input);
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].map((a) => a.address);
  try {
    await withProvider(account, (provider) => provider.send(mime, { from: account.email, to: recipients }));
  } catch (err) {
    throw new Error(`发送失败：${describeImapError(err)}`);
  }

  // 发送成功后的收尾：已发送副本、\Answered、删除旧草稿、清理上传文件
  const preset = account.presetId ? getPreset(account.presetId as PresetId) : undefined;
  if (!preset?.serverSavesSent) {
    await appendToRoleFolder(account, "sent", mime, ["Seen"]);
  }
  if (payload.inReplyToMessageId) await markAnswered(payload.inReplyToMessageId).catch(() => undefined);
  if (payload.draftMessageId) await deleteMessageHard(userId, payload.draftMessageId).catch(() => undefined);
  for (const a of payload.attachments) removeUpload(a.id);
  return { messageId };
}

export async function saveDraft(userId: string, accountId: string, payload: ComposePayload): Promise<void> {
  const account = await loadAccount(userId, accountId);
  const from: EmailAddress = { name: account.displayName ?? undefined, address: account.email };
  const thread = await resolveThreadHeaders(payload.inReplyToMessageId);
  const input = composeInput(payload, from, thread, []);
  const { mime } = await buildMime(input);
  await appendToRoleFolder(account, "drafts", mime, ["Draft", "Seen"]);
  if (payload.draftMessageId) await deleteMessageHard(userId, payload.draftMessageId).catch(() => undefined);
  for (const a of payload.attachments) removeUpload(a.id);
}
