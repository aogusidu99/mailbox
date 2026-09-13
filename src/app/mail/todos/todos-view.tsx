"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { toggleTodoAction } from "@/app/mail/actions";
import { Card, CardContent } from "@/components/ui/card";
import { formatListDate } from "@/lib/format";
import type { TodoItem } from "@/server/ai/todos";
import { cn } from "cn";

export function TodosView({ todos }: { todos: TodoItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  /** 乐观更新的完成状态（key = messageId:index） */
  const [localDone, setLocalDone] = useState<Record<string, boolean>>({});
  const isDone = (messageId: string, index: number, fallback?: boolean) => localDone[`${messageId}:${index}`] ?? Boolean(fallback);
  const toggle = (messageId: string, index: number, done: boolean) => {
    setLocalDone((s) => ({ ...s, [`${messageId}:${index}`]: done }));
    start(async () => {
      const r = await toggleTodoAction(messageId, index, done);
      if (!r.ok) {
        toast.error(r.error);
        setLocalDone((s) => ({ ...s, [`${messageId}:${index}`]: !done }));
      }
      router.refresh();
    });
  };

  if (todos.length === 0) {
    return <p className="text-sm text-muted-foreground">暂时没有待办。给账号打开「AI 处理」后，新邮件里的待办会自动出现在这里。</p>;
  }
  return (
    <div className="space-y-3">
      {todos.map((t) => (
        <Card key={t.messageId}>
          <CardContent className="space-y-2 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("rounded px-1 text-[10px]", t.priority === "high" ? "bg-red-100 text-red-700" : "bg-muted text-muted-foreground")}>{t.categoryLabel}</span>
              {t.needsReply ? <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800">需回复</span> : null}
              <Link href={`/mail/${t.accountId}/${t.folderId}?m=${t.messageId}`} className="font-medium hover:underline">
                {t.subject ?? "(无主题)"}
              </Link>
              <span className="text-xs text-muted-foreground">
                {t.from} · {formatListDate(t.date)}
              </span>
            </div>
            {t.items.length ? (
              <ul className="space-y-1">
                {t.items.map((it) => (
                  <li key={it.index} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={isDone(t.messageId, it.index, it.done)}
                      disabled={pending}
                      onChange={(e) => toggle(t.messageId, it.index, e.target.checked)}
                      aria-label={`完成：${it.title}`}
                    />
                    <span className={cn(isDone(t.messageId, it.index, it.done) && "text-muted-foreground line-through")}>{it.title}</span>
                    {it.dueAt ? <span className="text-xs text-muted-foreground">（{it.dueAt}）</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
