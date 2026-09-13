import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/session";
import { ChatView } from "./chat-view";

export const metadata: Metadata = { title: "和邮箱对话 · Mailbox" };

export default async function ChatPage() {
  await requireUserPage();
  return (
    <main className="mx-auto flex h-full w-full max-w-3xl flex-col p-4">
      <ChatView />
    </main>
  );
}
