"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Archive,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileText,
  Folder,
  Inbox,
  Languages,
  ListTodo,
  Loader2,
  Mail,
  MessageSquare,
  Plus,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { setLocaleAction } from "@/app/locale-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import type { SidebarData } from "@/lib/api-types";
import { useLocale, useT } from "@/lib/locale-context";
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

const COLLAPSED_KEY = "mailbox:collapsedAccounts";

/** 从 localStorage 读取各邮箱折叠状态（SSR / 出错时返回空） */
function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

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
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [switching, startSwitch] = useTransition();
  const params = useParams<{ accountId?: string; folderId?: string }>();
  const { data } = useQuery({ queryKey: ["sidebar"], queryFn: api.sidebar, initialData: initial, refetchInterval: 30_000 });
  const roleLabels = t.folder as Record<string, string>;

  // 每个邮箱折叠/展开状态，记在 localStorage
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // 挂载后从 localStorage 恢复折叠状态（先渲染默认值，避免 SSR/客户端不一致）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 一次性从 localStorage 水合 UI 偏好
    setCollapsed(readCollapsed());
  }, []);
  const persistCollapsed = (next: Record<string, boolean>) => {
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
    } catch {
      /* 忽略 */
    }
  };
  const toggleAccount = (id: string) => persistCollapsed({ ...collapsed, [id]: !collapsed[id] });
  const allCollapsed = data.accounts.length > 0 && data.accounts.every((a) => collapsed[a.id]);
  const toggleAll = () => {
    const next: Record<string, boolean> = {};
    for (const a of data.accounts) next[a.id] = !allCollapsed;
    persistCollapsed(next);
  };

  const switchLocale = () =>
    startSwitch(async () => {
      await setLocaleAction(locale === "zh-CN" ? "en" : "zh-CN");
      router.refresh();
    });

  const navLink = (href: string, Icon: React.ComponentType<{ className?: string }>, label: string) => (
    <Link href={href} onClick={onNavigate} className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-sidebar-accent">
      <Icon className="size-3.5" /> {label}
    </Link>
  );

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-12 items-center justify-between border-b px-3">
        <Link href="/mail" className="font-semibold" onClick={onNavigate}>
          {t.appName}
        </Link>
        <div className="flex items-center gap-1">
          {data.accounts.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button type="button" onClick={toggleAll} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label={allCollapsed ? t.nav.expandAll : t.nav.collapseAll} />
                }
              >
                {allCollapsed ? <ChevronsUpDown className="size-4" /> : <ChevronsDownUp className="size-4" />}
              </TooltipTrigger>
              <TooltipContent>{allCollapsed ? t.nav.expandAll : t.nav.collapseAll}</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Link href="/mail/accounts/new" onClick={onNavigate} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label={t.nav.addAccount} />
              }
            >
              <Plus className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t.nav.addAccount}</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger render={<button type="button" className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label={t.nav.settings} />}>
              <Settings className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem render={<Link href="/mail/accounts" onClick={onNavigate} />}>{t.nav.accounts}</DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/mail/settings/ai" onClick={onNavigate} />}>{t.nav.ai}</DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/mail/settings/rules" onClick={onNavigate} />}>{t.nav.mailRules}</DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/mail/settings/oauth" onClick={onNavigate} />}>{t.nav.oauth}</DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/mail/digest" onClick={onNavigate} />}>{t.nav.digest}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-0.5 border-b px-2 py-1.5 text-xs">
        {navLink("/mail/chat", MessageSquare, t.nav.chat)}
        {navLink("/mail/calendar", CalendarDays, t.nav.calendar)}
        {navLink("/mail/tasks", ListTodo, t.nav.tasks)}
        {navLink("/mail/digest", Sparkles, t.nav.digest)}
        {navLink("/mail/settings/rules", Wand2, t.nav.rules)}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <nav className="space-y-4 p-2">
          {data.accounts.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t.nav.noAccounts}
              <div className="mt-2">
                <Button size="sm" render={<Link href="/mail/accounts/new" onClick={onNavigate} />}>
                  {t.nav.addAccount}
                </Button>
              </div>
            </div>
          ) : null}
          {data.accounts.map((account) => (
            <div key={account.id}>
              <button
                type="button"
                onClick={() => toggleAccount(account.id)}
                className="flex w-full items-center gap-1 rounded-md px-1 pb-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                aria-expanded={!collapsed[account.id]}
              >
                {collapsed[account.id] ? <ChevronRight className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
                <span className="truncate" title={account.email}>
                  {account.displayName || account.email}
                </span>
                {account.syncStatus === "syncing" ? <Loader2 className="size-3 animate-spin" /> : null}
                {account.syncStatus === "error" ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="inline-flex" />}>
                      <AlertCircle className="size-3 text-destructive" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">{account.syncError ?? t.nav.syncError}</TooltipContent>
                  </Tooltip>
                ) : null}
              </button>
              {!collapsed[account.id] ? (
                <>
                  {account.folders.length === 0 ? <div className="px-2 py-1 text-xs text-muted-foreground">{t.nav.fetchingFolders}</div> : null}
                  <ul className="space-y-0.5">
                    {account.folders
                      .filter((f) => !f.noSelect || f.depth === 0)
                      .map((folder) => {
                        const Icon = ROLE_ICONS[folder.role] ?? Folder;
                        const active = params.accountId === account.id && params.folderId === folder.id;
                        const label = folder.role !== "other" && folder.depth === 0 ? (roleLabels[folder.role] ?? folder.name) : folder.name;
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
                </>
              ) : null}
            </div>
          ))}
        </nav>
      </div>

      <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
        <span className="truncate" title={userEmail}>
          {userEmail}
        </span>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="xs" onClick={switchLocale} disabled={switching} aria-label={t.nav.language}>
            <Languages className="size-3.5" /> {t.nav.language}
          </Button>
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="xs">
              {t.nav.signOut}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
