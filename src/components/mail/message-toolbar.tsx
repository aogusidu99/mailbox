"use client";

import { Archive, FolderInput, Forward, Inbox, Loader2, Mail, MailOpen, Pencil, Reply, ReplyAll, ShieldAlert, Sparkles, Star, Trash2, Wand2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { aiAnalyzeAction, archiveAction, flagAction, junkAction, markReadAction, moveAction, notJunkAction, trashAction } from "@/app/mail/actions";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MessageDetail, SidebarFolder } from "@/lib/api-types";

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
  const [pending, start] = useTransition();
  const ids = [message.id];

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, after: "removed" | "changed", success?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error ?? "操作失败");
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
          <Pencil className="size-4" /> 编辑草稿
        </Button>
      ) : (
        <>
          <IconButton label="回复" onClick={() => onCompose("reply")}>
            <Reply className="size-4" />
          </IconButton>
          <IconButton label="全部回复" onClick={() => onCompose("replyAll")}>
            <ReplyAll className="size-4" />
          </IconButton>
          <IconButton label="转发" onClick={() => onCompose("forward")}>
            <Forward className="size-4" />
          </IconButton>
          <IconButton label="AI 起草回复" onClick={() => onCompose("aiReply")}>
            <Sparkles className="size-4" />
          </IconButton>
          <IconButton label="AI 分析" disabled={pending} onClick={() => act(() => aiAnalyzeAction(message.id), "changed", "已完成 AI 分析")}>
            <Wand2 className="size-4" />
          </IconButton>
        </>
      )}
      <span className="mx-1 h-5 w-px bg-border" />
      {!isTrash && message.folderRole !== "archive" && message.folderRole !== "all" ? (
        <IconButton label="归档" disabled={pending} onClick={() => act(() => archiveAction(ids), "removed", "已归档")}>
          <Archive className="size-4" />
        </IconButton>
      ) : null}
      <IconButton label={isTrash ? "彻底删除" : "删除"} disabled={pending} onClick={() => act(() => trashAction(ids), "removed", isTrash ? "已彻底删除" : "已移到已删除")}>
        <Trash2 className="size-4" />
      </IconButton>
      {isJunk ? (
        <IconButton label="不是垃圾邮件" disabled={pending} onClick={() => act(() => notJunkAction(ids), "removed", "已移回收件箱")}>
          <Inbox className="size-4" />
        </IconButton>
      ) : (
        <IconButton label="标为垃圾邮件" disabled={pending} onClick={() => act(() => junkAction(ids), "removed", "已标为垃圾邮件")}>
          <ShieldAlert className="size-4" />
        </IconButton>
      )}
      <span className="mx-1 h-5 w-px bg-border" />
      <IconButton label={message.seen ? "标为未读" : "标为已读"} disabled={pending} onClick={() => act(() => markReadAction(ids, !message.seen), "changed")}>
        {message.seen ? <Mail className="size-4" /> : <MailOpen className="size-4" />}
      </IconButton>
      <IconButton label={message.flagged ? "取消星标" : "加星标"} disabled={pending} onClick={() => act(() => flagAction(ids, !message.flagged), "changed")}>
        <Star className={message.flagged ? "size-4 fill-amber-400 text-amber-400" : "size-4"} />
      </IconButton>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="移动到" disabled={pending} />}>
          <FolderInput className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-auto">
          {folders
            .filter((f) => !f.noSelect && f.id !== message.folderId)
            .map((f) => (
              <DropdownMenuItem key={f.id} onClick={() => act(() => moveAction(ids, f.id), "removed", `已移动到 ${f.name}`)}>
                <span style={{ paddingLeft: `${Math.min(f.depth, 4) * 10}px` }}>{f.name}</span>
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {pending ? <Loader2 className="ml-1 size-4 animate-spin text-muted-foreground" /> : null}
    </>
  );
}
