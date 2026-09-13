"use client";

import { MailWorkspace } from "@/components/mail/mail-workspace";
import { refreshFolderAction } from "@/app/mail/accounts/actions";

/** 文件夹页面的客户端外壳：把 Server Action 注入工作区（M2 起在这里加操作工具栏）。 */
export function FolderWorkspace({
  accountId,
  folderId,
  folderName,
}: {
  accountId: string;
  folderId: string;
  folderName: string;
  folderRole: string;
  accountEmail: string;
}) {
  return (
    <MailWorkspace
      accountId={accountId}
      folderId={folderId}
      folderName={folderName}
      onRefresh={() => refreshFolderAction(accountId, folderId)}
    />
  );
}
