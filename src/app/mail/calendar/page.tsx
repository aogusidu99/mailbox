import type { Metadata } from "next";
import { headers } from "next/headers";
import { getEnv } from "@/env";
import { GoogleConnectPrompt } from "@/components/mail/google-connect";
import { requireUserPage } from "@/server/auth/session";
import { listCalendars, listEvents, type CalEvent, type CalendarMeta } from "@/server/google/calendar";
import { getGoogleStatus, googleRedirectUri } from "@/server/google/connection";
import { getDefaultTaskListId, listAllTasks, type TaskList, type TaskWithList } from "@/server/google/tasks";
import { listOAuthClients } from "@/server/oauth/clients";
import { CalendarWorkspace } from "./calendar-workspace";

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
  // 日历页整合了任务面板，需要日历 + 任务两个权限
  const ready = status.connected && status.hasCalendar && status.hasTasks;

  if (!ready) {
    return (
      <main className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
        <div>
          <h1 className="text-xl font-semibold">日历</h1>
          <p className="text-sm text-muted-foreground">日历事件 + Google 任务整合在一个页面（仿 Google 日历）。需要连接 Google 并授予日历、任务权限。</p>
        </div>
        <GoogleConnectPrompt status={status} need={status.connected && !status.hasTasks ? "tasks" : "calendar"} redirectUri={googleRedirectUri(base)} hasClient={hasClient} error={error} />
      </main>
    );
  }

  // 已就绪：一次性拉取日历列表 + 事件 + 任务
  let calendars: CalendarMeta[] = [];
  let events: CalEvent[] = [];
  let lists: TaskList[] = [];
  let taskItems: TaskWithList[] = [];
  let defaultListId = "@default";
  let loadError: string | null = error;
  try {
    const [cals, ev, all, defaultId] = await Promise.all([
      listCalendars(user.id).catch(() => []),
      listEvents(user.id).catch(() => []),
      listAllTasks(user.id),
      getDefaultTaskListId(user.id),
    ]);
    calendars = cals;
    events = ev;
    lists = all.lists;
    taskItems = all.tasks;
    defaultListId = defaultId ?? all.lists[0]?.id ?? "@default";
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <div className="h-full">
      <CalendarWorkspace initialEvents={events} calendars={calendars} email={status.email} initialError={loadError} tasks={{ lists, defaultListId, initialTasks: taskItems }} />
    </div>
  );
}
