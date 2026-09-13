"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PenSquare } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { refreshFolderAction } from "@/app/mail/accounts/actions";
import { markReadAction, searchOnServerAction } from "@/app/mail/actions";
import { ComposeDialog, type ComposeInitial } from "@/components/mail/compose-dialog";
import { MailWorkspace } from "@/components/mail/mail-workspace";
import { MessageToolbar, type ReplyKind } from "@/components/mail/message-toolbar";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import type { MessageDetail, MessageListItem } from "@/lib/api-types";
import { formatAddrList, forwardHeader, forwardSubject, quoteText, replyAllRecipients, replySubject, stripHtml } from "@/lib/quote";

/** 文件夹页面的客户端外壳：注入操作工具栏、写信对话框、自动已读。 */
export function FolderWorkspace({
  accountId,
  folderId,
  folderName,
  accountEmail,
}: {
  accountId: string;
  folderId: string;
  folderName: string;
  folderRole: string;
  accountEmail: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { data: sidebar } = useQuery({ queryKey: ["sidebar"], queryFn: api.sidebar });
  const folders = sidebar?.accounts.find((a) => a.id === accountId)?.folders ?? [];

  const [compose, setCompose] = useState<{ key: number; open: boolean; initial?: ComposeInitial }>({ key: 0, open: false });
  const openCompose = useCallback((initial?: ComposeInitial) => setCompose((c) => ({ key: c.key + 1, open: true, initial })), []);

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["messages", accountId] });
    await queryClient.invalidateQueries({ queryKey: ["sidebar"] });
  }, [queryClient, accountId]);

  const clearSelection = useCallback(() => {
    router.replace(pathname, { scroll: false });
  }, [router, pathname]);

  // 打开未读邮件 0.8 秒后自动标为已读
  const readTimer = useRef<NodeJS.Timeout | null>(null);
  const onOpenMessage = useCallback(
    (item: MessageListItem) => {
      if (readTimer.current) clearTimeout(readTimer.current);
      if (item.seen) return;
      readTimer.current = setTimeout(async () => {
        const r = await markReadAction([item.id], true);
        if (r.ok) {
          await queryClient.invalidateQueries({ queryKey: ["message", item.id] });
          await invalidate();
        }
      }, 800);
    },
    [queryClient, invalidate],
  );
  useEffect(() => () => {
    if (readTimer.current) clearTimeout(readTimer.current);
  }, []);

  const buildCompose = (m: MessageDetail, kind: ReplyKind): ComposeInitial => {
    const bodyText = m.text?.trim() || (m.html ? stripHtml(m.html) : "");
    switch (kind) {
      case "reply":
        return {
          to: formatAddrList(m.replyTo.length ? m.replyTo : m.from),
          subject: replySubject(m.subject),
          text: quoteText({ from: m.from, date: m.date, text: m.text, html: m.html }),
          inReplyToMessageId: m.id,
        };
      case "replyAll": {
        const r = replyAllRecipients({ from: m.from, replyTo: m.replyTo, to: m.to, cc: m.cc, self: accountEmail });
        return {
          to: formatAddrList(r.to),
          cc: formatAddrList(r.cc),
          subject: replySubject(m.subject),
          text: quoteText({ from: m.from, date: m.date, text: m.text, html: m.html }),
          inReplyToMessageId: m.id,
        };
      }
      case "forward":
        return {
          subject: forwardSubject(m.subject),
          text: `${forwardHeader({ from: m.from, to: m.to, date: m.date, subject: m.subject })}${bodyText}`,
          forwardOfMessageId: m.id,
          includeOriginalAttachments: m.attachments.length > 0,
          originalAttachmentNames: m.attachments.map((a) => a.filename || "附件"),
        };
      case "editDraft":
        return {
          to: formatAddrList(m.to),
          cc: formatAddrList(m.cc),
          bcc: formatAddrList(m.bcc),
          subject: m.subject ?? "",
          text: bodyText,
          draftMessageId: m.id,
        };
    }
  };

  const onServerSearch = async (q: string) => {
    const r = await searchOnServerAction(accountId, folderId, q);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(`服务器上找到 ${r.data.matched} 封，新导入 ${r.data.imported} 封`);
    await invalidate();
  };

  return (
    <>
      <MailWorkspace
        accountId={accountId}
        folderId={folderId}
        folderName={folderName}
        onRefresh={() => refreshFolderAction(accountId, folderId)}
        onOpenMessage={onOpenMessage}
        onServerSearch={onServerSearch}
        listHeaderExtra={
          <Button size="sm" onClick={() => openCompose()}>
            <PenSquare className="size-4" /> 写邮件
          </Button>
        }
        viewToolbar={(m) => (
          <MessageToolbar
            message={m}
            folders={folders}
            onCompose={(kind) => openCompose(buildCompose(m, kind))}
            onRemoved={() => {
              clearSelection();
              void invalidate();
            }}
            onChanged={() => {
              void queryClient.invalidateQueries({ queryKey: ["message", m.id] });
              void invalidate();
            }}
          />
        )}
      />
      {compose.open ? (
        <ComposeDialog
          key={compose.key}
          open={compose.open}
          onOpenChange={(open) => setCompose((c) => ({ ...c, open }))}
          accountId={accountId}
          accountEmail={accountEmail}
          initial={compose.initial}
          onSent={() => void invalidate()}
        />
      ) : null}
    </>
  );
}
