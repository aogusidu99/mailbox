import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";
import { listAccounts } from "@/server/mail/accounts";
import { AccountRow } from "./account-row";

export const metadata: Metadata = { title: "邮箱管理 · Mailbox" };

export default async function AccountsPage() {
  const user = await requireUserPage();
  const accounts = await listAccounts(user.id);
  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">邮箱管理</h1>
        <Button render={<Link href="/mail/accounts/new" />}>添加邮箱</Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>已连接的邮箱</CardTitle>
          <CardDescription>可以手动触发同步、开关 AI 处理或移除邮箱（移除只删除本地缓存，不影响服务器上的邮件）。</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {accounts.length === 0 ? <p className="py-4 text-sm text-muted-foreground">还没有连接任何邮箱。</p> : null}
          {accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={{
                id: a.id,
                email: a.email,
                displayName: a.displayName,
                presetId: a.presetId,
                syncStatus: a.syncStatus,
                syncError: a.syncError,
                lastSyncAt: a.lastSyncAt ? a.lastSyncAt.toISOString() : null,
                aiEnabled: a.aiEnabled,
                syncWindowDays: a.syncWindowDays,
              }}
            />
          ))}
        </CardContent>
      </Card>
    </main>
  );
}
