import type { Metadata } from "next";
import { listTodos } from "@/server/ai/todos";
import { requireUserPage } from "@/server/auth/session";
import { TodosView } from "./todos-view";

export const metadata: Metadata = { title: "待办 · Mailbox" };

export default async function TodosPage() {
  const user = await requireUserPage();
  const todos = await listTodos(user.id);
  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">待办</h1>
        <p className="text-sm text-muted-foreground">AI 从最近 60 天的邮件里抽取的待办事项与需要回复的邮件。</p>
      </div>
      <TodosView todos={todos} />
    </main>
  );
}
