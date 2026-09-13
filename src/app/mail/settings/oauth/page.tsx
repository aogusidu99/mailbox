import type { Metadata } from "next";
import { headers } from "next/headers";
import { getEnv } from "@/env";
import { requireUserPage } from "@/server/auth/session";
import { listOAuthClients } from "@/server/oauth/clients";
import { OAUTH_PROVIDERS } from "@/server/oauth/providers";
import { OAuthPanel } from "./oauth-panel";

export const metadata: Metadata = { title: "OAuth 设置 · Mailbox" };

export default async function OAuthSettingsPage(props: PageProps<"/mail/settings/oauth">) {
  const user = await requireUserPage();
  const sp = await props.searchParams;
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const base = getEnv().APP_BASE_URL?.replace(/\/+$/, "") || `${proto}://${host}`;
  const clients = await listOAuthClients(user.id);
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">OAuth 授权登录</h1>
        <p className="text-sm text-muted-foreground">
          Gmail 与 Outlook 除了「应用专用密码 / 授权码」，还可以用 OAuth 授权登录（Outlook 个人版只能走 OAuth）。需要你先在厂商控制台注册一个应用并填入凭据。
        </p>
        <p className="text-sm text-muted-foreground">按全局约定，Google 授权请在系统默认浏览器里完成。</p>
      </div>
      <OAuthPanel
        providers={Object.values(OAUTH_PROVIDERS).map((p) => ({
          id: p.id,
          label: p.label,
          help: p.help,
          redirectUri: `${base}/api/oauth/${p.id}/callback`,
          clientId: clients.find((c) => c.provider === p.id)?.clientId ?? "",
        }))}
        error={typeof sp.error === "string" ? sp.error : null}
      />
    </main>
  );
}
