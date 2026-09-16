"use client";

import { Archive, Bot, FolderInput, Forward, Inbox, Loader2, Mail, MailOpen, Pencil, Reply, ReplyAll, ShieldAlert, Sparkles, Star, Trash2, Wand2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { aiAnalyzeAction, archiveAction, flagAction, junkAction, markReadAction, moveAction, notJunkAction, tagForAssistantAction, trashAction } from "@/app/mail/actions";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MessageDetail, SidebarFolder } from "@/lib/api-types";
import { fmt } from "@/lib/i18n";
import { useT } from "@/lib/locale-context";

export type ReplyKind = "reply" | "replyAll" | "forward" | "editDraft" | "aiReply";

function IconButton({ label, onClick, disabled, children }: { label: string; onClick?: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={onClick} disabled={disabled} aria-label={label} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function MessageToolbar({
  message,
  folders,
  onCompose,
  onRemoved,
  onChanged,
}: {
  message: MessageDetail;
  folders: SidebarFolder[];
  onCompose: (kind: ReplyKind) => void;
  /** 邮件已离开当前文件夹（归档 / 删除 / 移动） */
  onRemoved: () => void;
  /** 标记变化 */
  onChanged: () => void;
}) {
  const t = useT().toolbar;
  const [pending, start] = useTransition();
  const ids = [message.id];

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, after: "removed" | "changed", success?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error ?? t.actionFailed);
        return;
      }
      if (success) toast.success(success);
      if (after === "removed") onRemoved();
      else onChanged();
    });

  const isDraft = message.folderRole === "drafts" || message.draft;
  const isJunk = message.folderRole === "junk";
  const isTrash = message.folderRole === "trash";

  return (
    <>
      {isDraft ? (
        <Button size="sm" onClick={() => onCompose("editDraft")}>
          <Pencil className="size-4" /> {t.editDraft}
        </Button>
      ) : (
        <>
          <IconButton label={t.reply} onClick={() => onCompose("reply")}>
            <Reply className="size-4" />
          </IconButton>
          <IconButton label={t.replyAll} onClick={() => onCompose("replyAll")}>
            <ReplyAll className="size-4" />
          </IconButton>
          <IconButton label={t.forward} onClick={() => onCompose("forward")}>
            <Forward className="size-4" />
          </IconButton>
          <IconButton label={t.aiReply} onClick={() => onCompose("aiReply")}>
            <Sparkles className="size-4" />
          </IconButton>
          <IconButton label={t.aiAnalyze} disabled={pending} onClick={() => act(() => aiAnalyzeAction(message.id), "changed", t.aiAnalyzed)}>
            <Wand2 className="size-4" />
          </IconButton>
          <IconButton label={t.assistant} disabled={pending} onClick={() => act(() => tagForAssistantAction(ids), "changed", t.assistantDone)}>
            <Bot className="size-4" />
          </IconButton>
        </>
      )}
      <span className="mx-1 h-5 w-px bg-border" />
      {!isTrash && message.folderRole !== "archive" && message.folderRole !== "all" ? (
        <IconButton label={t.archive} disabled={pending} onClick={() => act(() => archiveAction(ids), "removed", t.archived)}>
          <Archive className="size-4" />
        </IconButton>
      ) : null}
      <IconButton label={isTrash ? t.deleteForever : t.delete} disabled={pending} onClick={() => act(() => trashAction(ids), "removed", isTrash ? t.deletedForever : t.movedToTrash)}>
        <Trash2 className="size-4" />
      </IconButton>
      {isJunk ? (
        <IconButton label={t.notJunk} disabled={pending} onClick={() => act(() => notJunkAction(ids), "removed", t.movedToInbox)}>
          <Inbox className="size-4" />
        </IconButton>
      ) : (
        <IconButton label={t.junk} disabled={pending} onClick={() => act(() => junkAction(ids), "removed", t.markedJunk)}>
          <ShieldAlert className="size-4" />
        </IconButton>
      )}
      <span className="mx-1 h-5 w-px bg-border" />
      <IconButton label={message.seen ? t.markUnread : t.markRead} disabled={pending} onClick={() => act(() => markReadAction(ids, !message.seen), "changed")}>
        {message.seen ? <Mail className="size-4" /> : <MailOpen className="size-4" />}
      </IconButton>
      <IconButton label={message.flagged ? t.unflag : t.flag} disabled={pending} onClick={() => act(() => flagAction(ids, !message.flagged), "changed")}>
        <Star className={message.flagged ? "size-4 fill-amber-400 text-amber-400" : "size-4"} />
      </IconButton>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t.moveTo} disabled={pending} />}>
          <FolderInput className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-auto">
          {folders
            .filter((f) => !f.noSelect && f.id !== message.folderId)
            .map((f) => (
              <DropdownMenuItem key={f.id} onClick={() => act(() => moveAction(ids, f.id), "removed", fmt(t.movedTo, { folder: f.name }))}>
                <span style={{ paddingLeft: `${Math.min(f.depth, 4) * 10}px` }}>{f.name}</span>
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {pending ? <Loader2 className="ml-1 size-4 animate-spin text-muted-foreground" /> : null}
    </>
  );
}
