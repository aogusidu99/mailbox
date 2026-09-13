import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, type Db } from "@/db";
import { folders, mailAccounts, mailOps, messages, type Folder, type MailAccount, type Message } from "@/db/schema";
import { enqueueOutboxApply } from "@/server/jobs/queues";
import type { MailOperation } from "@/server/providers/types";
import { publish } from "@/server/realtime/bus";
import type { StoredOperation } from "@/server/sync/outbox";

/**
 * 邮件操作服务：先乐观更新本地缓存，再把操作写入 outbox 由 worker 回放到服务器。
 */

export interface OwnedMessage {
  account: MailAccount;
  folder: Folder;
  message: Message;
}

export async function loadOwnedMessages(userId: string, ids: string[]): Promise<OwnedMessage[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .select({ message: messages, folder: folders, account: mailAccounts })
    .from(messages)
    .innerJoin(folders, eq(folders.id, messages.folderId))
    .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
    .where(and(inArray(messages.id, ids), eq(mailAccounts.userId, userId)));
  return rows;
}

async function createOp(db: Db, accountId: string, op: MailOperation, affectedFolders: string[], idempotencyKey = randomUUID()): Promise<string> {
  const stored: StoredOperation =
    op.type === "append"
      ? { op: { ...op, mime: undefined, mimeBase64: Buffer.from(op.mime).toString("base64") } as StoredOperation["op"], affectedFolders }
      : { op, affectedFolders };
  const [row] = await db
    .insert(mailOps)
    .values({ accountId, type: op.type, payload: stored as unknown as Record<string, unknown>, idempotencyKey })
    .returning({ id: mailOps.id });
  return row.id;
}

/** 按账号 + 文件夹分组 */
function groupByFolder(rows: OwnedMessage[]): Map<string, { account: MailAccount; folder: Folder; items: Message[] }> {
  const map = new Map<string, { account: MailAccount; folder: Folder; items: Message[] }>();
  for (const r of rows) {
    const key = r.folder.id;
    if (!map.has(key)) map.set(key, { account: r.account, folder: r.folder, items: [] });
    map.get(key)!.items.push(r.message);
  }
  return map;
}

async function bumpUnread(db: Db, folderId: string, delta: number) {
  if (delta === 0) return;
  await db
    .update(folders)
    .set({ unreadCount: sql`greatest(0, ${folders.unreadCount} + ${delta})` })
    .where(eq(folders.id, folderId));
}

async function bumpTotal(db: Db, folderId: string, delta: number) {
  if (delta === 0) return;
  await db
    .update(folders)
    .set({ totalCount: sql`greatest(0, ${folders.totalCount} + ${delta})` })
    .where(eq(folders.id, folderId));
}

function withFlag(flags: string[], name: string, on: boolean): string[] {
  const rest = flags.filter((f) => f.toLowerCase() !== name.toLowerCase());
  return on ? [...rest, name] : rest;
}

/** 已读 / 未读、星标 */
export async function markMessages(userId: string, ids: string[], patch: { seen?: boolean; flagged?: boolean }): Promise<void> {
  const db = await getDb();
  const groups = groupByFolder(await loadOwnedMessages(userId, ids));
  for (const { account, folder, items } of groups.values()) {
    const add: string[] = [];
    const remove: string[] = [];
    if (patch.seen === true) add.push("Seen");
    if (patch.seen === false) remove.push("Seen");
    if (patch.flagged === true) add.push("Flagged");
    if (patch.flagged === false) remove.push("Flagged");
    if (!add.length && !remove.length) continue;

    let unreadDelta = 0;
    for (const m of items) {
      let flags = m.flags;
      if (patch.seen !== undefined) {
        if (m.seen !== patch.seen) unreadDelta += patch.seen ? -1 : 1;
        flags = withFlag(flags, "Seen", patch.seen);
      }
      if (patch.flagged !== undefined) flags = withFlag(flags, "Flagged", patch.flagged);
      await db
        .update(messages)
        .set({
          flags,
          ...(patch.seen !== undefined ? { seen: patch.seen } : {}),
          ...(patch.flagged !== undefined ? { flagged: patch.flagged } : {}),
        })
        .where(eq(messages.id, m.id));
    }
    await bumpUnread(db, folder.id, unreadDelta);
    await createOp(db, account.id, { type: "set_flags", folder: folder.path, uids: items.map((m) => m.uid), add, remove }, [folder.path]);
    await enqueueOutboxApply(account.id);
    publish({ type: "folder", accountId: account.id, folderId: folder.id, folderPath: folder.path });
  }
}

/** 回复后给原邮件打 \Answered */
export async function markAnswered(messageId: string): Promise<void> {
  const db = await getDb();
  const row = await db
    .select({ message: messages, folder: folders })
    .from(messages)
    .innerJoin(folders, eq(folders.id, messages.folderId))
    .where(eq(messages.id, messageId))
    .then((r) => r[0]);
  if (!row) return;
  await db.update(messages).set({ answered: true, flags: withFlag(row.message.flags, "Answered", true) }).where(eq(messages.id, messageId));
  await createOp(db, row.message.accountId, { type: "set_flags", folder: row.folder.path, uids: [row.message.uid], add: ["Answered"] }, [row.folder.path]);
  await enqueueOutboxApply(row.message.accountId);
}

async function resolveTargetFolder(db: Db, account: MailAccount, role: "archive" | "trash" | "junk" | "inbox"): Promise<{ path: string; folder?: Folder; needsCreate: boolean }> {
  const all = await db.query.folders.findMany({ where: eq(folders.accountId, account.id) });
  const isGmail = account.presetId === "gmail" || account.provider === "gmail";
  // Gmail 的「归档」= 移出收件箱，即移动到 All Mail
  const wanted = role === "archive" && isGmail ? all.find((f) => f.role === "all") : all.find((f) => f.role === role);
  if (wanted) return { path: wanted.path, folder: wanted, needsCreate: false };
  if (role === "archive") {
    const inbox = all.find((f) => f.role === "inbox");
    const delimiter = inbox?.delimiter || "/";
    // 有的服务器要求子文件夹放在 INBOX 下
    const prefix = all.some((f) => f.path.startsWith(`INBOX${delimiter}`)) && !all.some((f) => !f.path.startsWith("INBOX")) ? `INBOX${delimiter}` : "";
    return { path: `${prefix}Archive`, needsCreate: true };
  }
  throw new Error(`该邮箱没有「${role === "trash" ? "已删除" : role === "junk" ? "垃圾邮件" : "收件箱"}」文件夹`);
}

/** 移动到指定文件夹（本地先删除源记录，同步后出现在目标文件夹） */
export async function moveMessages(userId: string, ids: string[], target: { folderId?: string; role?: "archive" | "trash" | "junk" | "inbox" }): Promise<void> {
  const db = await getDb();
  const groups = groupByFolder(await loadOwnedMessages(userId, ids));
  for (const { account, folder, items } of groups.values()) {
    let targetPath: string;
    let needsCreate = false;
    if (target.folderId) {
      const t = await db.query.folders.findFirst({ where: and(eq(folders.id, target.folderId), eq(folders.accountId, account.id)) });
      if (!t) throw new Error("目标文件夹不存在");
      targetPath = t.path;
    } else if (target.role) {
      const r = await resolveTargetFolder(db, account, target.role);
      targetPath = r.path;
      needsCreate = r.needsCreate;
    } else {
      throw new Error("缺少目标文件夹");
    }
    if (targetPath === folder.path) continue;

    const unread = items.filter((m) => !m.seen).length;
    await db.delete(messages).where(inArray(messages.id, items.map((m) => m.id)));
    await bumpUnread(db, folder.id, -unread);
    await bumpTotal(db, folder.id, -items.length);

    if (needsCreate) await createOp(db, account.id, { type: "create_folder", folder: targetPath }, []);
    await createOp(db, account.id, { type: "move", folder: folder.path, uids: items.map((m) => m.uid), toFolder: targetPath }, [folder.path, targetPath]);
    await enqueueOutboxApply(account.id);
    publish({ type: "folder", accountId: account.id, folderId: folder.id, folderPath: folder.path });
  }
}

/** 删除：不在「已删除」里的移到已删除；已经在里面的彻底删除 */
export async function deleteMessages(userId: string, ids: string[]): Promise<void> {
  const db = await getDb();
  const rows = await loadOwnedMessages(userId, ids);
  const inTrash = rows.filter((r) => r.folder.role === "trash");
  const others = rows.filter((r) => r.folder.role !== "trash");
  if (others.length) await moveMessages(userId, others.map((r) => r.message.id), { role: "trash" });
  for (const { account, folder, items } of groupByFolder(inTrash).values()) {
    const unread = items.filter((m) => !m.seen).length;
    await db.delete(messages).where(inArray(messages.id, items.map((m) => m.id)));
    await bumpUnread(db, folder.id, -unread);
    await bumpTotal(db, folder.id, -items.length);
    await createOp(db, account.id, { type: "delete", folder: folder.path, uids: items.map((m) => m.uid) }, [folder.path]);
    await enqueueOutboxApply(account.id);
    publish({ type: "folder", accountId: account.id, folderId: folder.id, folderPath: folder.path });
  }
}

/** 把 MIME 追加到指定角色的文件夹（草稿 / 已发送）。 */
export async function appendToRoleFolder(account: MailAccount, role: "drafts" | "sent", mime: Buffer, flags: string[]): Promise<void> {
  const db = await getDb();
  const all = await db.query.folders.findMany({ where: eq(folders.accountId, account.id) });
  let target = all.find((f) => f.role === role)?.path;
  if (!target) {
    target = role === "drafts" ? "Drafts" : "Sent";
    await createOp(db, account.id, { type: "create_folder", folder: target }, []);
  }
  await createOp(db, account.id, { type: "append", folder: target, mime, flags, date: new Date() }, [target]);
  await enqueueOutboxApply(account.id);
}

/** 彻底删除一封本地已知的邮件（用于替换旧草稿） */
export async function deleteMessageHard(userId: string, messageId: string): Promise<void> {
  const db = await getDb();
  const [row] = await loadOwnedMessages(userId, [messageId]);
  if (!row) return;
  await db.delete(messages).where(eq(messages.id, messageId));
  await bumpTotal(db, row.folder.id, -1);
  if (!row.message.seen) await bumpUnread(db, row.folder.id, -1);
  await createOp(db, row.account.id, { type: "delete", folder: row.folder.path, uids: [row.message.uid] }, [row.folder.path]);
  await enqueueOutboxApply(row.account.id);
  publish({ type: "folder", accountId: row.account.id, folderId: row.folder.id, folderPath: row.folder.path });
}

/** Gmail 标签（AI 分类写回用） */
export async function setGmailLabels(accountId: string, folderPath: string, uids: number[], add: string[], remove: string[] = []): Promise<void> {
  const db = await getDb();
  await createOp(db, accountId, { type: "set_labels", folder: folderPath, uids, add, remove }, [folderPath]);
  await enqueueOutboxApply(accountId);
}

/** 通用移动（AI 分类写回：复制到 AI/<类别> 文件夹等）。 */
export async function enqueueRawOperation(accountId: string, op: MailOperation, affectedFolders: string[]): Promise<void> {
  const db = await getDb();
  await createOp(db, accountId, op, affectedFolders);
  await enqueueOutboxApply(accountId);
}
