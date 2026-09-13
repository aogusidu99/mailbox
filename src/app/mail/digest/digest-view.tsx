"use client";

import { Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { refreshDigestAction } from "@/app/mail/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DigestItem } from "@/server/ai/assist";
import { cn } from "cn";

/** 极简 Markdown 渲染：标题 / 列表 / 段落 */
function renderMarkdown(md: string) {
  const lines = md.split("\n");
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      out.push(
        <ul key={`ul-${out.length}`} className="list-disc space-y-1 pl-5">
          {list.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^[-*] /.test(line)) {
      list.push(line.replace(/^[-*] /, "").replace(/\*\*(.+?)\*\*/g, "$1"));
      continue;
    }
    flush();
    if (!line) continue;
    if (/^#{1,3} /.test(line)) out.push(<h3 key={out.length} className="mt-3 font-semibold">{line.replace(/^#+ /, "")}</h3>);
    else out.push(<p key={out.length}>{line.replace(/\*\*(.+?)\*\*/g, "$1")}</p>);
  }
  flush();
  return out;
}

export function DigestView({ day, items, content, model, error }: { day: string; items: DigestItem[]; content: string | null; model?: string; error: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const refresh = () =>
    start(async () => {
      const r = await refreshDigestAction(day);
      if (!r.ok) toast.error(r.error);
      else toast.success("已重新生成");
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>AI 摘要{model ? <span className="ml-2 text-xs font-normal text-muted-foreground">{model}</span> : null}</CardTitle>
          <Button size="sm" variant="outline" onClick={refresh} disabled={pending || items.length === 0}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} 重新生成
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {error ? <p className="text-destructive">{error}</p> : null}
          {content ? renderMarkdown(content) : <p className="text-muted-foreground">{items.length === 0 ? "这一天还没有经过 AI 分析的邮件。给账号打开「AI 处理」或在 AI 设置里回填后再来看。" : "尚未生成。"}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>邮件清单（{items.length}）</CardTitle>
        </CardHeader>
        <CardContent className="divide-y text-sm">
          {items.map((i) => (
            <Link key={i.messageId} href={`/mail/${i.accountId}/${i.folderId}?m=${i.messageId}`} className="block py-2 hover:bg-muted/50">
              <div className="flex items-center gap-2">
                <span className={cn("rounded px-1 text-[10px]", i.priority === "high" ? "bg-red-100 text-red-700" : "bg-muted text-muted-foreground")}>{i.categoryLabel}</span>
                {i.needsReply ? <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800">需回复</span> : null}
                <span className="font-medium">{i.from}</span>
                <span className="truncate text-muted-foreground">{i.subject ?? "(无主题)"}</span>
              </div>
              <div className="text-xs text-muted-foreground">{i.summary}</div>
              {i.actionItems.length ? (
                <div className="text-xs">
                  待办：{i.actionItems.map((a) => `${a.title}${a.dueAt ? `（${a.dueAt}）` : ""}`).join("；")}
                </div>
              ) : null}
            </Link>
          ))}
          {items.length === 0 ? <p className="py-2 text-muted-foreground">无</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
