import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { getServerDict } from "@/lib/locale-server";
import { requireUserPage } from "@/server/auth/session";
import { getAccountForUser } from "@/server/mail/accounts";
import { ALL_MAIL_ID } from "@/server/mail/queries";
import { FolderWorkspace } from "./folder-workspace";

export default async function FolderPage(props: PageProps<"/mail/[accountId]/[folderId]">) {
  const { accountId, folderId } = await props.params;
  const user = await requireUserPage();
  const ROLE_LABELS = (await getServerDict()).folder as Record<string, string>;
  const account = await getAccountForUser(user.id, accountId);
  if (!account) notFound();
  // 虚拟「所有邮件」视图：没有真实文件夹行，直接渲染工作区
  if (folderId === ALL_MAIL_ID) {
    return <FolderWorkspace accountId={accountId} folderId={ALL_MAIL_ID} folderName={ROLE_LABELS.all ?? "所有邮件"} folderRole="all" accountEmail={account.email} />;
  }
  const db = await getDb();
  const folder = await db.query.folders.findFirst({ where: eq(folders.id, folderId) });
  if (!folder || folder.accountId !== accountId) notFound();
  const name = folder.role !== "other" && !folder.path.includes(folder.delimiter ?? "/") ? (ROLE_LABELS[folder.role] ?? folder.name) : folder.name;
  return <FolderWorkspace accountId={accountId} folderId={folderId} folderName={name} folderRole={folder.role} accountEmail={account.email} />;
}
