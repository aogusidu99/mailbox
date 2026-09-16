import type { Metadata } from "next";
import { headers } from "next/headers";
import { getEnv } from "@/env";
import { GoogleConnectPrompt } from "@/components/mail/google-connect";
import { requireUserPage } from "@/server/auth/session";
import { listEvents, type CalEvent } from "@/server/google/calendar";
import { getGoogleStatus, googleRedirectUri } from "@/server/google/connection";
import { listOAuthClients } from "@/server/oauth/clients";
import { CalendarView } from "./calendar-view";

export const metadata: Metadata = { title: "日历 · Mailbox" };

export default async function CalendarPage(props: PageProps<"/mail/calendar">) {
  const user = await requireUserPage();
  const sp = await props.searchParams;
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const base = getEnv().APP_BASE_URL?.replace(/\/+$/, "") || `${proto}://${host}`;
  const error = typeof sp.error === "string" ? sp.error : null;

  const [status, clients] = await Promise.all([getGoogleStatus(user.id), listOAuthClients(user.id)]);
  const hasClient = clients.some((c) => c.provider === "google");

  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold">日历</h1>
        <p className="text-sm text-muted-foreground">直接查看 / 编辑 Google 日历事件（会议、约会等带时间的日程），改动实时双向同步；也可让 AI 从邮件提取日程加入。（待办请到「谷歌任务」页管理。）</p>
      </div>

      {!status.connected || !status.hasCalendar ? (
        <GoogleConnectPrompt status={status} need="calendar" redirectUri={googleRedirectUri(base)} hasClient={hasClient} error={error} />
      ) : (
        <CalendarLoader userId={user.id} email={status.email} error={error} />
      )}
    </main>
  );
}

/** 拉取初始事件后渲染视图 */
async function CalendarLoader({ userId, email, error }: { userId: string; email: string | null; error: string | null }) {
  let events: CalEvent[] = [];
  let loadError: string | null = error;
  try {
    events = await listEvents(userId);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }
  return <CalendarView initialEvents={events} email={email} initialError={loadError} />;
}
