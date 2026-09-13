"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/lib/api-client";

/** 新账号首次同步时的等待页：文件夹一出现就跳到收件箱。 */
export function WaitingForSync({ accountId }: { accountId: string }) {
  const router = useRouter();
  const { data } = useQuery({ queryKey: ["sidebar"], queryFn: api.sidebar, refetchInterval: 2000 });
  useEffect(() => {
    const account = data?.accounts.find((a) => a.id === accountId);
    const inbox = account?.folders.find((f) => f.role === "inbox") ?? account?.folders[0];
    if (inbox) router.replace(`/mail/${accountId}/${inbox.id}`);
  }, [data, accountId, router]);
  const account = data?.accounts.find((a) => a.id === accountId);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      <Loader2 className="size-6 animate-spin" />
      <div>正在连接邮箱并获取文件夹…</div>
      {account?.syncStatus === "error" ? <div className="max-w-md text-destructive">{account.syncError}</div> : null}
    </div>
  );
}
