"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { deleteOAuthClientAction, saveOAuthClientAction } from "./actions";

export interface OAuthProviderView {
  id: string;
  label: string;
  help: string[];
  redirectUri: string;
  clientId: string;
}

export function OAuthPanel({ providers, error }: { providers: OAuthProviderView[]; error: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<Record<string, { clientId: string; clientSecret: string }>>(Object.fromEntries(providers.map((p) => [p.id, { clientId: p.clientId, clientSecret: "" }])));

  const save = (id: string) =>
    start(async () => {
      const r = await saveOAuthClientAction(id, form[id].clientId, form[id].clientSecret);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("已保存，现在可以点「连接账号」");
        setForm((f) => ({ ...f, [id]: { ...f[id], clientSecret: "" } }));
      }
      router.refresh();
    });

  const remove = (id: string) =>
    start(async () => {
      const r = await deleteOAuthClientAction(id);
      if (!r.ok) toast.error(r.error);
      else toast.success("已删除");
      setForm((f) => ({ ...f, [id]: { clientId: "", clientSecret: "" } }));
      router.refresh();
    });

  return (
    <div className="space-y-6">
      {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
      {providers.map((p) => (
        <Card key={p.id}>
          <CardHeader>
            <CardTitle>{p.label}</CardTitle>
            <CardDescription>
              回调地址（填到厂商控制台）：<code className="rounded bg-muted px-1">{p.redirectUri}</code>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              {p.help.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ol>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input aria-label={`${p.label} 客户端 ID`} placeholder="客户端 ID" value={form[p.id].clientId} onChange={(e) => setForm((f) => ({ ...f, [p.id]: { ...f[p.id], clientId: e.target.value } }))} />
              <Input
                aria-label={`${p.label} 客户端密钥`}
                type="password"
                autoComplete="off"
                placeholder={p.clientId ? "已保存（输入新值可替换）" : "客户端密钥"}
                value={form[p.id].clientSecret}
                onChange={(e) => setForm((f) => ({ ...f, [p.id]: { ...f[p.id], clientSecret: e.target.value } }))}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => save(p.id)} disabled={pending || !form[p.id].clientId || !form[p.id].clientSecret}>
                保存凭据
              </Button>
              {p.clientId ? (
                <>
                  <Button size="sm" variant="outline" render={<a href={`/api/oauth/${p.id}/start`} />}>
                    连接{p.id === "google" ? " Gmail " : " Outlook "}账号
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(p.id)} disabled={pending}>
                    删除凭据
                  </Button>
                </>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
