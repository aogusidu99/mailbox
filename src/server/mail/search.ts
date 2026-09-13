import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, mailAccounts, messages } from "@/db/schema";
import { withProvider } from "@/server/providers/factory";
import { publish } from "@/server/realtime/bus";
import { ingestEnvelopes } from "@/server/sync/engine";

/**
 * 服务器端搜索：让 IMAP 服务器在整个文件夹（含本地窗口之外的历史邮件）里搜索，
 * 把命中的邮件信封回填到本地缓存，之后本地搜索即可看到它们。
 */
export async function searchOnServer(userId: string, accountId: string, folderId: string, query: string): Promise<{ matched: number; imported: number }> {
  const db = await getDb();
  const account = await db.query.mailAccounts.findFirst({ where: and(eq(mailAccounts.id, accountId), eq(mailAccounts.userId, userId)) });
  const folder = await db.query.folders.findFirst({ where: and(eq(folders.id, folderId), eq(folders.accountId, accountId)) });
  if (!account || !folder) throw new Error("账号或文件夹不存在");

  return withProvider(account, async (provider) => {
    const uids = await provider.searchUids(folder.path, query);
    if (uids.length === 0) return { matched: 0, imported: 0 };
    const local = new Set(
      (await db.select({ uid: messages.uid }).from(messages).where(eq(messages.folderId, folder.id))).map((r) => r.uid),
    );
    const missing = uids.filter((u) => !local.has(u)).slice(0, 500);
    const imported = missing.length ? await ingestEnvelopes(db, account, folder, provider.fetchByUids(folder.path, missing)) : 0;
    if (imported > 0) {
      publish({ type: "folder", accountId, folderId: folder.id, folderPath: folder.path });
      const { enqueueFetchBodies } = await import("@/server/jobs/queues");
      await enqueueFetchBodies(accountId, folder.id);
    }
    return { matched: uids.length, imported };
  });
}
