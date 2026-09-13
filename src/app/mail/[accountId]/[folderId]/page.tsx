import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { requireUserPage } from "@/server/auth/session";
import { getAccountForUser } from "@/server/mail/accounts";
import { FolderWorkspace } from "./folder-workspace";

const ROLE_LABELS: Record<string, string> = {
  inbox: "收件箱",
  sent: "已发送",
  drafts: "草稿箱",
  trash: "已删除",
  junk: "垃圾邮件",
  archive: "归档",
  all: "所有邮件",
};

export default async function FolderPage(props: PageProps<"/mail/[accountId]/[folderId]">) {
  const { accountId, folderId } = await props.params;
  const user = await requireUserPage();
  const account = await getAccountForUser(user.id, accountId);
  if (!account) notFound();
  const db = await getDb();
  const folder = await db.query.folders.findFirst({ where: eq(folders.id, folderId) });
  if (!folder || folder.accountId !== accountId) notFound();
  const name = folder.role !== "other" && !folder.path.includes(folder.delimiter ?? "/") ? (ROLE_LABELS[folder.role] ?? folder.name) : folder.name;
  return <FolderWorkspace accountId={accountId} folderId={folderId} folderName={name} folderRole={folder.role} accountEmail={account.email} />;
}
