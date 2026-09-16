import type { Metadata } from "next";
import { headers } from "next/headers";
import { getEnv } from "@/env";
import { GoogleConnectPrompt } from "@/components/mail/google-connect";
import { requireUserPage } from "@/server/auth/session";
import { listEvents, type CalEvent } from "@/server/google/calendar";
import { getGoogleStatus, googleRedirectUri } from "@/server/google/connection";
import { getDefaultTaskListId, listAllTasks, type TaskList, type TaskWithList } from "@/server/google/tasks";
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
  // 日历页统一以 Google 任务承载日程；需要日历 + 任务两个权限
  const ready = status.connected && status.hasCalendar && status.hasTasks;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold">日历</h1>
        <p className="text-sm text-muted-foreground">日程统一以 Google 任务承载（按日期显示、实时双向同步）；也可让 AI 从邮件提取日程加入。真实日历（节假日等）只读显示作背景。</p>
      </div>

      {!ready ? (
        <GoogleConnectPrompt status={status} need={status.connected && !status.hasTasks ? "tasks" : "calendar"} redirectUri={googleRedirectUri(base)} hasClient={hasClient} error={error} />
      ) : (
        <CalendarLoader userId={user.id} email={status.email} error={error} />
      )}
    </main>
  );
}

/** 拉取初始数据（任务 + 只读事件 + 清单）后渲染视图 */
async function CalendarLoader({ userId, email, error }: { userId: string; email: string | null; error: string | null }) {
  let events: CalEvent[] = [];
  let tasks: TaskWithList[] = [];
  let lists: TaskList[] = [];
  let defaultListId = "@default";
  let loadError: string | null = error;
  try {
    const [ev, all, defaultId] = await Promise.all([listEvents(userId).catch(() => []), listAllTasks(userId), getDefaultTaskListId(userId)]);
    events = ev;
    tasks = all.tasks;
    lists = all.lists;
    defaultListId = defaultId ?? all.lists[0]?.id ?? "@default";
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }
  return <CalendarView initialEvents={events} initialTasks={tasks} lists={lists} defaultListId={defaultListId} email={email} initialError={loadError} />;
}
