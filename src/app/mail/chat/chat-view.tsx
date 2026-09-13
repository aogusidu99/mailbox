"use client";

import { Bot, Loader2, MessageSquarePlus, Plus, Send, Trash2, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { archiveAction, flagAction, junkAction, labelAction, markReadAction, trashAction } from "@/app/mail/actions";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import type { ChatProposal, ChatTrace } from "@/server/ai/agent";
import type { StoredTurn, ThreadSummary } from "@/server/ai/chat-store";
import { cn } from "cn";
import { deleteThreadAction, sendChatMessageAction } from "./actions";

interface Turn {
  role: "user" | "assistant";
  content: string;
  proposals?: ChatProposal[];
  trace?: ChatTrace[];
  model?: string;
}

const ACTION_LABELS: Record<ChatProposal["action"], string> = {
  archive: "归档",
  trash: "删除",
  mark_read: "标为已读",
  flag: "加星标",
  junk: "标为垃圾邮件",
  label: "打标签",
};

const SUGGESTIONS = ["今天有哪些需要我回复的邮件？", "帮我找上个月的发票", "最近有没有面试相关的邮件？", "把所有推广邮件归档"];

export function ChatView({ threads, threadId, initialTurns }: { threads: ThreadSummary[]; threadId: string | null; initialTurns: StoredTurn[] }) {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>(() =>
    initialTurns.map((m) => ({ role: m.role, content: m.content, proposals: m.proposals, trace: m.trace, model: m.model })),
  );
  const [input, setInput] = useState("");
  const [pending, start] = useTransition();
  const [done, setDone] = useState<Set<string>>(new Set());
  const bottom = useRef<HTMLDivElement>(null);

  const send = (text: string) => {
    const message = text.trim();
    if (!message) return;
    setTurns((t) => [...t, { role: "user", content: message }]);
    setInput("");
    start(async () => {
      const r = await sendChatMessageAction(threadId, message);
      if (!r.ok) {
        toast.error(r.error);
        setTurns((t) => [...t, { role: "assistant", content: `出错了：${r.error}` }]);
        return;
      }
      setTurns((t) => [...t, { role: "assistant", content: r.data.turn.reply, proposals: r.data.turn.proposals, trace: r.data.turn.trace, model: r.data.turn.model }]);
      if (!threadId) router.replace(`/mail/chat?t=${r.data.threadId}`, { scroll: false });
      else router.refresh();
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);
    });
  };

  const remove = (id: string) =>
    start(async () => {
      const r = await deleteThreadAction(id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (id === threadId) router.push("/mail/chat");
      else router.refresh();
    });

  const execute = (p: ChatProposal, key: string) =>
    start(async () => {
      const ids = [p.messageId];
      const r =
        p.action === "archive"
          ? await archiveAction(ids)
          : p.action === "trash"
            ? await trashAction(ids)
            : p.action === "mark_read"
              ? await markReadAction(ids, true)
              : p.action === "flag"
                ? await flagAction(ids, true)
                : p.action === "junk"
                  ? await junkAction(ids)
                  : await labelAction(ids, p.value ?? "AI/Other");
      if (!r.ok) toast.error(r.error);
      else {
        toast.success(`已${ACTION_LABELS[p.action]}：${p.subject ?? ""}`);
        setDone((s) => new Set(s).add(key));
      }
    });

  const threadRow = (th: ThreadSummary) => (
    <div key={th.id} className={cn("group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-muted", th.id === threadId && "bg-muted font-medium")}>
      <Link href={`/mail/chat?t=${th.id}`} className="min-w-0 flex-1 truncate">
        {th.title}
      </Link>
      <button type="button" aria-label="删除会话" className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100" onClick={() => remove(th.id)} disabled={pending}>
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );

  return (
    <>
      <aside className="hidden w-56 shrink-0 flex-col md:flex">
        <Button size="sm" variant="outline" render={<Link href="/mail/chat" />}>
          <Plus className="size-4" /> 新对话
        </Button>
        <div className="mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {threads.length === 0 ? <p className="px-2 py-4 text-xs text-muted-foreground">还没有历史对话</p> : threads.map(threadRow)}
        </div>
      </aside>

      <div className="flex h-full min-h-0 flex-1 flex-col">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">和邮箱对话</h1>
            <p className="text-xs text-muted-foreground">AI 会先检索你的邮件再回答；涉及归档、删除等操作时只会给出建议，由你确认后执行。历史对话已保存，可随时续聊。</p>
          </div>
          <div className="md:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" variant="outline" aria-label="历史对话" />}>
                <MessageSquarePlus className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-auto">
                <DropdownMenuItem render={<Link href="/mail/chat" />}>
                  <Plus className="size-4" /> 新对话
                </DropdownMenuItem>
                {threads.map((th) => (
                  <DropdownMenuItem key={th.id} render={<Link href={`/mail/chat?t=${th.id}`} />} className={th.id === threadId ? "font-medium" : ""}>
                    <span className="truncate">{th.title}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto rounded-md border p-3">
          {turns.length === 0 ? (
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <Button key={s} size="sm" variant="outline" onClick={() => send(s)}>
                  {s}
                </Button>
              ))}
            </div>
          ) : null}
          {turns.map((t, i) => (
            <div key={i} className={cn("flex gap-2", t.role === "user" ? "justify-end" : "justify-start")}>
              {t.role === "assistant" ? <Bot className="mt-1 size-4 shrink-0 text-muted-foreground" /> : null}
              <div className={cn("max-w-[85%] space-y-2 rounded-lg px-3 py-2 text-sm", t.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted")}>
                <div className="whitespace-pre-wrap">{t.content}</div>
                {t.proposals?.length ? (
                  <div className="space-y-1 rounded-md border bg-background p-2">
                    <div className="text-xs font-medium">操作建议（需要你确认）</div>
                    {t.proposals.map((p, j) => {
                      const key = `${i}-${j}`;
                      return (
                        <div key={key} className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="rounded bg-muted px-1">
                            {ACTION_LABELS[p.action]}
                            {p.value ? ` ${p.value}` : ""}
                          </span>
                          <span className="truncate">{p.subject ?? p.messageId}</span>
                          <span className="text-muted-foreground">— {p.reason}</span>
                          {done.has(key) ? (
                            <span className="text-emerald-600">已执行</span>
                          ) : (
                            <Button size="xs" onClick={() => execute(p, key)} disabled={pending}>
                              执行
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {t.trace?.length ? (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">
                      查看检索过程（{t.trace.length} 步{t.model ? ` · ${t.model}` : ""}）
                    </summary>
                    <ul className="mt-1 list-disc pl-4">
                      {t.trace.map((s, k) => (
                        <li key={k}>
                          {s.tool}：{s.summary}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
              {t.role === "user" ? <User className="mt-1 size-4 shrink-0 text-muted-foreground" /> : null}
            </div>
          ))}
          {pending ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> 正在检索邮件并思考…
            </div>
          ) : null}
          <div ref={bottom} />
        </div>
        <form
          className="mt-2 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <Textarea
            aria-label="向助理提问"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="问问你的邮箱…（Enter 发送，Shift+Enter 换行）"
            className="min-h-11 flex-1 resize-none"
          />
          <Button type="submit" disabled={pending || !input.trim()}>
            <Send className="size-4" />
          </Button>
        </form>
        <p className="mt-1 text-[11px] text-muted-foreground">
          找不到想要的邮件？先到{" "}
          <Link href="/mail/settings/ai" className="underline">
            AI 设置
          </Link>{" "}
          配置 embedding 模型以启用语义搜索。
        </p>
      </div>
    </>
  );
}
