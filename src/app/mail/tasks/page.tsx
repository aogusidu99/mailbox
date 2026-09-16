import type { Metadata } from "next";
import { headers } from "next/headers";
import { getEnv } from "@/env";
import { GoogleConnectPrompt } from "@/components/mail/google-connect";
import { requireUserPage } from "@/server/auth/session";
import { getGoogleStatus, googleRedirectUri } from "@/server/google/connection";
import { getDefaultTaskListId, listAllTasks, type TaskList, type TaskWithList } from "@/server/google/tasks";
import { listOAuthClients } from "@/server/oauth/clients";
import { TasksView } from "./tasks-view";

export const metadata: Metadata = { title: "Google 任务 · Mailbox" };

export default async function TasksPage(props: PageProps<"/mail/tasks">) {
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
        <h1 className="text-xl font-semibold">Google 任务</h1>
        <p className="text-sm text-muted-foreground">直接查看 / 编辑 Google 任务（Tasks），改动实时双向同步。</p>
      </div>

      {!status.connected || !status.hasTasks ? (
        <GoogleConnectPrompt status={status} need="tasks" redirectUri={googleRedirectUri(base)} hasClient={hasClient} error={error} />
      ) : (
        <TasksLoader userId={user.id} email={status.email} error={error} />
      )}
    </main>
  );
}

async function TasksLoader({ userId, email, error }: { userId: string; email: string | null; error: string | null }) {
  let lists: TaskList[] = [];
  let tasks: TaskWithList[] = [];
  let defaultListId: string | null = null;
  let loadError: string | null = error;
  try {
    const [all, defaultId] = await Promise.all([listAllTasks(userId), getDefaultTaskListId(userId)]);
    lists = all.lists;
    tasks = all.tasks;
    // 默认清单（我的任务）优先作为「新增到哪个清单」的默认项
    defaultListId = defaultId ?? lists[0]?.id ?? null;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }
  return <TasksView lists={lists} defaultListId={defaultListId} initialTasks={tasks} email={email} initialError={loadError} />;
}
