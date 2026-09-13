import { and, asc, eq, inArray, lte, or, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, mailAccounts, mailOps } from "@/db/schema";
import { withKeyedLock } from "@/lib/keyed-lock";
import { enqueueSyncFolder } from "@/server/jobs/queues";
import { withProvider } from "@/server/providers/factory";
import { describeImapError } from "@/server/providers/imap";
import type { MailOperation } from "@/server/providers/types";
import { publish } from "@/server/realtime/bus";

/**
 * outbox 回放：把 mail_ops 中 pending 的操作按创建顺序应用到邮件服务器。
 *
 * - 成功：status=applied，并对受影响的文件夹入队一次定向同步，让服务器状态回写本地。
 * - 失败：指数退避重试；超过上限标记 failed，并对源文件夹重新同步（服务器为准，本地乐观修改会被纠正），
 *   同时通过实时事件提示用户。
 */

const MAX_ATTEMPTS = 5;

/** payload 里 append 的 mime 以 base64 存储 */
export interface StoredOperation {
  op: Omit<MailOperation, "mime"> & { mimeBase64?: string };
  /** 受影响的文件夹路径（用于回放后定向同步） */
  affectedFolders: string[];
}

function toMailOperation(stored: StoredOperation): MailOperation {
  const op = stored.op as MailOperation & { mimeBase64?: string };
  if (op.type === "append") {
    return { ...op, mime: Buffer.from(op.mimeBase64 ?? "", "base64") };
  }
  return op;
}

export async function applyOutbox(accountId: string): Promise<{ applied: number; failed: number }> {
  return withKeyedLock(`outbox:${accountId}`, async () => {
    const db = await getDb();
    const account = await db.query.mailAccounts.findFirst({ where: eq(mailAccounts.id, accountId) });
    if (!account) return { applied: 0, failed: 0 };

    const now = new Date();
    const pending = await db.query.mailOps.findMany({
      where: and(
        eq(mailOps.accountId, accountId),
        inArray(mailOps.status, ["pending", "applying"]),
        or(isNull(mailOps.nextAttemptAt), lte(mailOps.nextAttemptAt, now)),
      ),
      orderBy: [asc(mailOps.createdAt)],
    });
    if (pending.length === 0) return { applied: 0, failed: 0 };

    let applied = 0;
    let failed = 0;
    const foldersToSync = new Set<string>();

    await withProvider(account, async (provider) => {
      for (const row of pending) {
        const stored = row.payload as unknown as StoredOperation;
        await db.update(mailOps).set({ status: "applying" }).where(eq(mailOps.id, row.id));
        try {
          const op = toMailOperation(stored);
          const result = await provider.applyOperation(op);
          await db
            .update(mailOps)
            .set({ status: "applied", appliedAt: new Date(), lastError: null })
            .where(eq(mailOps.id, row.id));
          applied += 1;
          for (const f of stored.affectedFolders) foldersToSync.add(f);
          publish({ type: "outbox", accountId, opId: row.id, status: "applied" });
          if (op.type === "append" && result.appendedUid) {
            console.log(`[outbox] ${account.email} 已追加到 ${op.folder}，uid=${result.appendedUid}`);
          }
        } catch (err) {
          const message = describeImapError(err);
          const attempts = row.attempts + 1;
          const exhausted = attempts >= MAX_ATTEMPTS;
          const delayMs = Math.min(10 * 60_000, 15_000 * 2 ** (attempts - 1));
          await db
            .update(mailOps)
            .set({
              status: exhausted ? "failed" : "pending",
              attempts,
              lastError: message,
              nextAttemptAt: exhausted ? null : new Date(Date.now() + delayMs),
            })
            .where(eq(mailOps.id, row.id));
          console.warn(`[outbox] ${account.email} 操作 ${row.type} 失败（第 ${attempts} 次）:`, message);
          if (exhausted) {
            failed += 1;
            for (const f of stored.affectedFolders) foldersToSync.add(f);
            publish({ type: "outbox", accountId, opId: row.id, status: "failed", error: message });
          }
        }
      }
    });

    // 受影响的文件夹重新同步，把服务器真实状态写回本地
    const known = await db.query.folders.findMany({ where: eq(folders.accountId, accountId) });
    for (const path of foldersToSync) {
      const folder = known.find((f) => f.path === path);
      await enqueueSyncFolder(accountId, folder ? { folderId: folder.id } : { folderPath: path });
    }
    return { applied, failed };
  });
}
