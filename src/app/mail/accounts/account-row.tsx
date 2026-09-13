"use client";

import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatFullDate } from "@/lib/format";
import { deleteAccountAction, resyncAccountAction, toggleAccountAiAction, toggleAccountBccSelfAction } from "./actions";

export interface AccountRowData {
  id: string;
  email: string;
  displayName: string | null;
  presetId: string | null;
  syncStatus: string;
  syncError: string | null;
  lastSyncAt: string | null;
  aiEnabled: boolean;
  bccSelfOnReply: boolean;
  syncWindowDays: number;
  authType: string;
}

const STATUS_LABEL: Record<string, string> = { idle: "正常", syncing: "同步中", error: "出错", disabled: "已停用" };

export function AccountRow({ account }: { account: AccountRowData }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const resync = () =>
    start(async () => {
      const r = await resyncAccountAction(account.id);
      if (r.ok) toast.success("已加入同步队列");
      else toast.error(r.error);
      router.refresh();
    });

  const remove = () =>
    start(async () => {
      const r = await deleteAccountAction(account.id);
      if (r.ok) toast.success("已移除邮箱");
      else toast.error(r.error);
      router.refresh();
    });

  const toggleAi = (enabled: boolean) =>
    start(async () => {
      const r = await toggleAccountAiAction(account.id, enabled);
      if (!r.ok) toast.error(r.error);
      router.refresh();
    });

  const toggleBccSelf = (enabled: boolean) =>
    start(async () => {
      const r = await toggleAccountBccSelfAction(account.id, enabled);
      if (!r.ok) toast.error(r.error);
      else toast.success(enabled ? "回复时将密送一份给自己" : "已关闭回复密送自己");
      router.refresh();
    });

  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{account.displayName || account.email}</span>
          {account.displayName ? <span className="truncate text-xs text-muted-foreground">{account.email}</span> : null}
          <Badge variant={account.syncStatus === "error" ? "destructive" : "secondary"}>{STATUS_LABEL[account.syncStatus] ?? account.syncStatus}</Badge>
        </div>
        <div className="text-xs text-muted-foreground">
          {account.presetId ?? "imap"}
          {account.authType === "oauth2" ? " · OAuth" : ""} · 同步范围 {account.syncWindowDays} 天 · 上次同步 {account.lastSyncAt ? formatFullDate(account.lastSyncAt) : "从未"}
          {account.authType === "oauth2" ? (
            <>
              {" · "}
              <a className="underline" href={`/api/oauth/${account.presetId === "outlook" ? "microsoft" : "google"}/start?login_hint=${encodeURIComponent(account.email)}`}>
                重新授权
              </a>
            </>
          ) : null}
        </div>
        {account.syncError ? <div className="text-xs text-destructive">{account.syncError}</div> : null}
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        AI 处理
        <Switch checked={account.aiEnabled} onCheckedChange={(v) => toggleAi(Boolean(v))} disabled={pending} />
      </label>
      <label className="flex items-center gap-2 text-xs text-muted-foreground" title="回复邮件时自动密送（BCC）一份到本邮箱，方便留底">
        回复密送自己
        <Switch checked={account.bccSelfOnReply} onCheckedChange={(v) => toggleBccSelf(Boolean(v))} disabled={pending} />
      </label>
      <Button variant="outline" size="sm" onClick={resync} disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} 立即同步
      </Button>
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="destructive" size="sm" disabled={pending} />}>
          <Trash2 className="size-4" /> 移除
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移除 {account.email}？</AlertDialogTitle>
            <AlertDialogDescription>只会删除本地缓存的邮件与凭据，服务器上的邮件不受影响。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>移除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
