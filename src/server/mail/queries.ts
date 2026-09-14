import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDb } from "@/db";
import { aiAnnotations, attachments, folders, mailAccounts, messages, type Message } from "@/db/schema";
import type { AttachmentDto, MessageDetail, MessageListItem, MessageListResponse, SidebarData } from "@/lib/api-types";
import { withWarmProvider } from "@/server/providers/warm-pool";
import { sanitizeEmailHtml, textToHtml } from "./html";
import { ensureMessageBody } from "@/server/sync/engine";
import { FOLDER_ROLE_ORDER } from "@/server/sync/engine";

/**
 * 邮件读取查询（列表 / 详情 / 侧栏 / 附件）。所有查询都以 userId 作为租户边界。
 */

const PAGE_SIZE = 50;

/** 列表排序用的有效日期：Date 头 → 服务器接收时间 → 入库时间 */
export const effectiveDate = sql<Date>`coalesce(${messages.date}, ${messages.internalDate}, ${messages.createdAt})`;

export async function getSidebarData(userId: string): Promise<SidebarData> {
  const db = await getDb();
  const accounts = await db.query.mailAccounts.findMany({
    where: eq(mailAccounts.userId, userId),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  if (accounts.length === 0) return { accounts: [] };
  const allFolders = await db.query.folders.findMany({ where: inArray(folders.accountId, accounts.map((a) => a.id)) });
  return {
    accounts: accounts.map((a) => ({
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      presetId: a.presetId,
      syncStatus: a.syncStatus,
      syncError: a.syncError,
      initialSyncDone: a.initialSyncDone,
      aiEnabled: a.aiEnabled,
      lastSyncAt: a.lastSyncAt ? a.lastSyncAt.toISOString() : null,
      folders: allFolders
        .filter((f) => f.accountId === a.id)
        .sort((x, y) => (FOLDER_ROLE_ORDER[x.role] ?? 9) - (FOLDER_ROLE_ORDER[y.role] ?? 9) || x.path.localeCompare(y.path, "zh-CN"))
        .map((f) => ({
          id: f.id,
          path: f.path,
          name: f.name,
          role: f.role,
          depth: f.delimiter ? f.path.split(f.delimiter).length - 1 : 0,
          noSelect: f.noSelect,
          unreadCount: f.unreadCount,
          totalCount: f.totalCount,
        })),
    })),
  };
}

function encodeCursor(date: Date, id: string): string {
  return Buffer.from(`${date.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { date: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const date = new Date(iso);
    if (!id || Number.isNaN(date.getTime())) return null;
    return { date, id };
  } catch {
    return null;
  }
}

export type MessageRow = Message & { effectiveDate: Date; ai: typeof aiAnnotations.$inferSelect | null };

export function toListItem(m: MessageRow): MessageListItem {
  return {
    id: m.id,
    accountId: m.accountId,
    folderId: m.folderId,
    uid: m.uid,
    subject: m.subject,
    from: m.fromAddrs,
    to: m.toAddrs,
    date: m.effectiveDate ? new Date(m.effectiveDate).toISOString() : null,
    snippet: m.snippet,
    seen: m.seen,
    flagged: m.flagged,
    answered: m.answered,
    draft: m.draft,
    hasAttachments: m.hasAttachments,
    threadId: m.threadId,
    bodyFetched: m.bodyFetchedAt != null,
    ai: m.ai
      ? { category: m.ai.category, priority: m.ai.priority, summary: m.ai.summary, actionItems: m.ai.actionItems, reason: m.ai.reason }
      : null,
  };
}

export interface ListMessagesParams {
  userId: string;
  accountId: string;
  folderId: string;
  cursor?: string | null;
  q?: string | null;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  category?: string | null;
  limit?: number;
}

export async function listMessages(params: ListMessagesParams): Promise<MessageListResponse> {
  const db = await getDb();
  const account = await db.query.mailAccounts.findFirst({
    where: and(eq(mailAccounts.id, params.accountId), eq(mailAccounts.userId, params.userId)),
  });
  if (!account) return { items: [], nextCursor: null };
  const limit = Math.min(params.limit ?? PAGE_SIZE, 200);

  const conds: SQL[] = [eq(messages.accountId, params.accountId), eq(messages.folderId, params.folderId)];
  if (params.unreadOnly) conds.push(eq(messages.seen, false));
  if (params.flaggedOnly) conds.push(eq(messages.flagged, true));
  if (params.q && params.q.trim()) {
    const term = `%${params.q.trim()}%`;
    conds.push(
      or(
        ilike(messages.subject, term),
        ilike(messages.snippet, term),
        sql`${messages.fromAddrs}::text ilike ${term}`,
        sql`${messages.toAddrs}::text ilike ${term}`,
      ) as SQL,
    );
  }
  if (params.category) conds.push(eq(aiAnnotations.category, params.category));
  if (params.cursor) {
    const c = decodeCursor(params.cursor);
    if (c) {
      conds.push(
        sql`(${effectiveDate} < ${c.date.toISOString()}::timestamptz or (${effectiveDate} = ${c.date.toISOString()}::timestamptz and ${messages.id} < ${c.id}))`,
      );
    }
  }

  const rows = await db
    .select({ message: messages, ai: aiAnnotations, effectiveDate })
    .from(messages)
    .leftJoin(aiAnnotations, eq(aiAnnotations.messageId, messages.id))
    .where(and(...conds))
    .orderBy(desc(effectiveDate), desc(messages.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map((r) => toListItem({ ...r.message, effectiveDate: r.effectiveDate, ai: r.ai }));
  const last = rows[limit - 1];
  return {
    items: page,
    nextCursor: hasMore && last ? encodeCursor(new Date(last.effectiveDate), last.message.id) : null,
  };
}

export async function getMessageDetail(userId: string, messageId: string, opts: { allowRemoteImages?: boolean } = {}): Promise<MessageDetail | null> {
  const db = await getDb();
  let message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message) return null;
  const account = await db.query.mailAccounts.findFirst({
    where: and(eq(mailAccounts.id, message.accountId), eq(mailAccounts.userId, userId)),
  });
  if (!account) return null;
  const folder = await db.query.folders.findFirst({ where: eq(folders.id, message.folderId) });
  if (!folder) return null;

  if (!message.bodyFetchedAt) {
    try {
      message = (await ensureMessageBody(messageId)) ?? message;
    } catch (err) {
      console.warn("[mail] 按需拉取正文失败:", err instanceof Error ? err.message : err);
    }
  }

  const ai = await db.query.aiAnnotations.findFirst({ where: eq(aiAnnotations.messageId, messageId) });
  const atts = await db.query.attachments.findMany({ where: eq(attachments.messageId, messageId) });

  let html: string | null = null;
  let blocked = 0;
  if (message.htmlBody) {
    const r = sanitizeEmailHtml(message.htmlBody, { allowRemoteImages: opts.allowRemoteImages });
    html = r.html;
    blocked = r.blockedRemoteImages;
  } else if (message.textBody) {
    html = textToHtml(message.textBody);
  }

  const headers = message.headers ?? {};
  const listUnsub = headers["list-unsubscribe"];
  const listUnsubPost = headers["list-unsubscribe-post"];
  const base = toListItem({
    ...message,
    effectiveDate: message.date ?? message.internalDate ?? message.createdAt,
    ai: ai ?? null,
  });
  return {
    ...base,
    cc: message.ccAddrs,
    bcc: message.bccAddrs,
    replyTo: message.replyToAddrs,
    messageId: message.messageId,
    html,
    text: message.textBody,
    blockedRemoteImages: blocked,
    attachments: atts
      .filter((a) => !a.inline || !a.contentId)
      .map<AttachmentDto>((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        inline: a.inline,
        contentId: a.contentId,
      })),
    headers,
    folderPath: folder.path,
    folderRole: folder.role,
    listUnsubscribe: Array.isArray(listUnsub) ? listUnsub.join(", ") : (listUnsub ?? null),
    listUnsubscribePost: Array.isArray(listUnsubPost) ? listUnsubPost.join(", ") : (listUnsubPost ?? null),
  };
}

const ATTACHMENT_DIR = path.resolve(process.cwd(), "data", "attachments");

/** 下载附件：优先本地缓存，否则从服务器拉取并缓存。 */
export async function getAttachmentContent(
  userId: string,
  attachmentId: string,
): Promise<{ content: Buffer; filename: string; mimeType: string } | null> {
  const db = await getDb();
  const att = await db.query.attachments.findFirst({ where: eq(attachments.id, attachmentId) });
  if (!att) return null;
  const message = await db.query.messages.findFirst({ where: eq(messages.id, att.messageId) });
  if (!message) return null;
  const account = await db.query.mailAccounts.findFirst({
    where: and(eq(mailAccounts.id, message.accountId), eq(mailAccounts.userId, userId)),
  });
  const folder = await db.query.folders.findFirst({ where: eq(folders.id, message.folderId) });
  if (!account || !folder) return null;

  const filename = att.filename || `attachment-${att.part}`;
  const mimeType = att.mimeType || "application/octet-stream";

  if (att.cachedPath && existsSync(att.cachedPath)) {
    return { content: readFileSync(att.cachedPath), filename, mimeType };
  }
  const fetched = await withWarmProvider(account, (provider) => provider.fetchAttachment(folder.path, message.uid, att.part));
  const dir = path.join(ATTACHMENT_DIR, message.id);
  mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
  const file = path.join(dir, att.part.replace(/[^0-9a-zA-Z.]/g, "_"));
  writeFileSync(/*turbopackIgnore: true*/ file, fetched.content);
  await db.update(attachments).set({ cachedPath: file }).where(eq(attachments.id, att.id));
  return { content: fetched.content, filename: fetched.filename || filename, mimeType: fetched.mimeType || mimeType };
}
