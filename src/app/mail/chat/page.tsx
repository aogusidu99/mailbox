import type { Metadata } from "next";
import { getThreadMessages, listThreads } from "@/server/ai/chat-store";
import { requireUserPage } from "@/server/auth/session";
import { ChatView } from "./chat-view";

export const metadata: Metadata = { title: "和邮箱对话 · Mailbox" };

export default async function ChatPage(props: PageProps<"/mail/chat">) {
  const user = await requireUserPage();
  const sp = await props.searchParams;
  const requested = typeof sp.t === "string" ? sp.t : null;
  const [threads, messages] = await Promise.all([
    listThreads(user.id),
    requested ? getThreadMessages(user.id, requested) : Promise.resolve(null),
  ]);
  const threadId = messages ? requested : null;
  return (
    <main className="mx-auto flex h-full w-full max-w-5xl gap-3 p-4">
      <ChatView key={threadId ?? "new"} threads={threads} threadId={threadId} initialTurns={messages ?? []} />
    </main>
  );
}
