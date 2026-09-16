import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { GoogleStatus } from "@/server/google/connection";

/**
 * 「连接 Google（日历 / 任务）」提示卡片。日历页与任务页在未连接 / 缺少对应权限时复用。
 * 纯服务端组件：只渲染说明与跳转链接（授权走系统默认浏览器完成，符合全局约定）。
 */
export function GoogleConnectPrompt({
  status,
  need,
  redirectUri,
  hasClient,
  error,
}: {
  status: GoogleStatus;
  need: "calendar" | "tasks";
  redirectUri: string;
  hasClient: boolean;
  error?: string | null;
}) {
  const needLabel = need === "calendar" ? "日历" : "任务";
  const missingScope = status.connected && (need === "calendar" ? !status.hasCalendar : !status.hasTasks);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">连接 Google {needLabel}</CardTitle>
        <CardDescription>
          {missingScope
            ? `已连接 ${status.email ?? "Google 账号"}，但没有${needLabel}权限，请重新连接并勾选${needLabel}范围。`
            : `连接你的 Google 账号后，这里可以直接查看和编辑 Google ${needLabel}，改动实时同步到 Google（双向）。`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive">{error}</div> : null}
        {!hasClient ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-800">
            还没有保存 Google 的 OAuth 客户端凭据。请先到{" "}
            <Link href="/mail/settings/oauth" className="underline">
              设置 → OAuth 授权登录
            </Link>{" "}
            填写 Google 客户端 ID 与密钥。日历 / 任务复用同一套凭据。
          </div>
        ) : null}
        <div>
          <p className="mb-1 font-medium">首次使用需要在 Google Cloud 控制台做一次配置：</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>打开 https://console.cloud.google.com/ ，选中与「OAuth 授权登录」相同的项目。</li>
            <li>「API 和服务 → 启用 API 和服务」：启用 Google Calendar API 与 Google Tasks API。</li>
            <li>「OAuth 同意屏幕 → 范围」：添加 .../auth/calendar 与 .../auth/tasks；把自己加为测试用户。</li>
            <li>
              「凭据 → OAuth 客户端 → 已获授权的重定向 URI」补充：<code className="rounded bg-muted px-1">{redirectUri}</code>
            </li>
            <li>回到本页点「连接 Google」完成授权（按全局约定，请在系统默认浏览器里完成 Google 登录）。</li>
          </ol>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!hasClient} render={<a href="/api/google/start" />}>
            {missingScope ? "重新连接 Google" : "连接 Google"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
