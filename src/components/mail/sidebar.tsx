"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Archive,
  FileText,
  Folder,
  Inbox,
  Loader2,
  Mail,
  Plus,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import type { SidebarData } from "@/lib/api-types";
import { cn } from "cn";

const ROLE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  trash: Trash2,
  junk: ShieldAlert,
  archive: Archive,
  all: Mail,
  other: Folder,
};

const ROLE_LABELS: Record<string, string> = {
  inbox: "收件箱",
  sent: "已发送",
  drafts: "草稿箱",
  trash: "已删除",
  junk: "垃圾邮件",
  archive: "归档",
  all: "所有邮件",
};

export function Sidebar({
  initial,
  userEmail,
  signOutAction,
  onNavigate,
}: {
  initial: SidebarData;
  userEmail: string;
  signOutAction: () => Promise<void>;
  onNavigate?: () => void;
}) {
  const params = useParams<{ accountId?: string; folderId?: string }>();
  const { data } = useQuery({ queryKey: ["sidebar"], queryFn: api.sidebar, initialData: initial, refetchInterval: 30_000 });

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-12 items-center justify-between border-b px-3">
        <Link href="/mail" className="font-semibold" onClick={onNavigate}>
          Mailbox
        </Link>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Link href="/mail/accounts/new" onClick={onNavigate} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted" />
              }
            >
              <Plus className="size-4" />
            </TooltipTrigger>
            <TooltipContent>添加邮箱</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger render={<button type="button" className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label="设置" />}>
              <Settings className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem render={<Link href="/mail/accounts" onClick={onNavigate} />}>邮箱管理</DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/mail/settings/ai" onClick={onNavigate} />}>AI 设置</DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/mail/digest" onClick={onNavigate} />}>每日摘要</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="flex gap-1 border-b px-2 py-1.5 text-xs">
        <Link href="/mail/digest" onClick={onNavigate} className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-sidebar-accent">
          <Sparkles className="size-3.5" /> 每日摘要
        </Link>
        <Link href="/mail/settings/ai" onClick={onNavigate} className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-sidebar-accent">
          <Settings className="size-3.5" /> AI 设置
        </Link>
      </div>

      <ScrollArea className="flex-1">
        <nav className="space-y-4 p-2">
          {data.accounts.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              还没有邮箱
              <div className="mt-2">
                <Button size="sm" render={<Link href="/mail/accounts/new" onClick={onNavigate} />}>
                  添加邮箱
                </Button>
              </div>
            </div>
          ) : null}
          {data.accounts.map((account) => (
            <div key={account.id}>
              <div className="flex items-center gap-1.5 px-2 pb-1 text-xs font-medium text-muted-foreground">
                <span className="truncate" title={account.email}>
                  {account.displayName || account.email}
                </span>
                {account.syncStatus === "syncing" ? <Loader2 className="size-3 animate-spin" /> : null}
                {account.syncStatus === "error" ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="inline-flex" />}>
                      <AlertCircle className="size-3 text-destructive" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">{account.syncError ?? "同步出错"}</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
              {account.folders.length === 0 ? (
                <div className="px-2 py-1 text-xs text-muted-foreground">正在获取文件夹…</div>
              ) : null}
              <ul className="space-y-0.5">
                {account.folders
                  .filter((f) => !f.noSelect || f.depth === 0)
                  .map((folder) => {
                    const Icon = ROLE_ICONS[folder.role] ?? Folder;
                    const active = params.accountId === account.id && params.folderId === folder.id;
                    const label = folder.role !== "other" && folder.depth === 0 ? (ROLE_LABELS[folder.role] ?? folder.name) : folder.name;
                    return (
                      <li key={folder.id}>
                        <Link
                          href={`/mail/${account.id}/${folder.id}`}
                          onClick={onNavigate}
                          aria-disabled={folder.noSelect}
                          className={cn(
                            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent",
                            active && "bg-sidebar-accent font-medium",
                            folder.noSelect && "pointer-events-none opacity-60",
                          )}
                          style={{ paddingLeft: `${8 + Math.min(folder.depth, 4) * 12}px` }}
                        >
                          <Icon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{label}</span>
                          {folder.unreadCount > 0 ? (
                            <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
                              {folder.unreadCount > 999 ? "999+" : folder.unreadCount}
                            </Badge>
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))}
        </nav>
      </ScrollArea>

      <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
        <span className="truncate" title={userEmail}>
          {userEmail}
        </span>
        <form action={signOutAction}>
          <Button type="submit" variant="ghost" size="xs">
            退出
          </Button>
        </form>
      </div>
    </div>
  );
}
