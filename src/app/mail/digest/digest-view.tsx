"use client";

import { Check, ChevronLeft, ChevronRight, Loader2, RefreshCw, Send, Sparkles, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { DigestActionType, DigestDisposition } from "@/db/schema";
import type { DigestItem, DigestKind } from "@/server/ai/digest";
import { cn } from "cn";
import {
  digestDraftReplyAction,
  digestSendReplyAction,
  executeDigestAction,
  refreshDigestAction,
  replanDigestAction,
  updateDispositionAction,
} from "./actions";

const DISPOSITION_LABELS: Record<DigestActionType, string> = {
  reply: "回复",
  flag: "加星标",
  todo: "记为待办",
  label: "打标签",
  archive: "归档",
  mark_read: "标记已读",
  unsubscribe: "退订",
  junk: "垃圾邮件",
  trash: "删除",
  none: "无需处理",
};
const DISPOSITION_ORDER: DigestActionType[] = ["reply", "flag", "todo", "label", "archive", "mark_read", "unsubscribe", "junk", "trash", "none"];

/** 需要用户单独操作、不进入批量执行的动作 */
function isAuto(action: DigestActionType): boolean {
  return action !== "reply" && action !== "none";
}

const PERIODS: Array<{ kind: DigestKind; label: string }> = [
  { kind: "day", label: "当天" },
  { kind: "week", label: "本周" },
  { kind: "month", label: "本月" },
  { kind: "since", label: "自上次以来" },
  { kind: "custom", label: "自定义" },
];

function shift(day: string, kind: DigestKind, delta: number): string {
  const d = new Date(`${day}T00:00:00`);
  if (kind === "week") d.setDate(d.getDate() + delta * 7);
  else if (kind === "month") d.setMonth(d.getMonth() + delta);
  else d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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

export function DigestView(props: {
  kind: DigestKind;
  day: string;
  from?: string;
  to?: string;
  periodKey: string;
  label: string;
  items: DigestItem[];
  content: string | null;
  plan: DigestDisposition[];
  model: string | null;
  error: string | null;
}) {
  const { kind, day, periodKey, label, items } = props;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [replyPending, startReply] = useTransition();

  const [content, setContent] = useState(props.content);
  const [plan, setPlan] = useState<DigestDisposition[]>(props.plan);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [nl, setNl] = useState("");
  const [reply, setReply] = useState<{ id: string; points: string; draft: string } | null>(null);
  const [customFrom, setCustomFrom] = useState(props.from ?? day);
  const [customTo, setCustomTo] = useState(props.to ?? day);

  const generated = content !== null || plan.length > 0;
  const planById = useMemo(() => new Map(plan.map((d) => [d.messageId, d])), [plan]);
  const opts = { day, from: props.from, to: props.to };

  const setDisp = (messageId: string, patch: Partial<DigestDisposition>) =>
    setPlan((p) => {
      const idx = p.findIndex((d) => d.messageId === messageId);
      if (idx < 0) return [...p, { messageId, action: "none", reason: "", ...patch } as DigestDisposition];
      const next = [...p];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });

  const generate = () =>
    start(async () => {
      const r = await refreshDigestAction(kind, opts);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setContent(r.data.content);
      setPlan(r.data.plan);
      setSelected(new Set());
      toast.success("已生成摘要与处理意见");
    });

  const applyNl = () =>
    start(async () => {
      const text = nl.trim();
      if (!text) return;
      const r = await replanDigestAction(periodKey, text);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setPlan(r.data.plan);
      setNl("");
      toast.success("已按你的要求调整处理意见");
    });

  const changeAction = (messageId: string, action: DigestActionType) => {
    setDisp(messageId, { action, status: "pending" });
    if (action === "reply") {
      const d = planById.get(messageId);
      setReply({ id: messageId, points: d?.replyPoints ?? "", draft: "" });
    }
    start(async () => {
      const r = await updateDispositionAction(periodKey, messageId, action);
      if (!r.ok) toast.error(r.error);
    });
  };

  const toggleSelect = (messageId: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(messageId);
      else next.delete(messageId);
      return next;
    });

  const selectableIds = plan.filter((d) => isAuto(d.action) && d.status !== "done").map((d) => d.messageId);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  const executeSelected = () =>
    start(async () => {
      const ids = [...selected];
      if (ids.length === 0) {
        toast.error("请先选择要处理的邮件");
        return;
      }
      const r = await executeDigestAction(periodKey, ids);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const doneSet = new Set(r.data.done);
      setPlan((p) => p.map((d) => (doneSet.has(d.messageId) ? { ...d, status: "done" } : d)));
      setSelected(new Set());
      toast.success(`已处理 ${r.data.done.length} 封${r.data.failed.length ? `，失败 ${r.data.failed.length} 封` : ""}`);
      router.refresh();
    });

  const generateReply = (messageId: string) =>
    startReply(async () => {
      if (!reply) return;
      const r = await digestDraftReplyAction(messageId, reply.points);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setReply((s) => (s ? { ...s, draft: r.data.text } : s));
      toast.success(`已用 ${r.data.model} 生成草稿，可编辑后发送`);
    });

  const sendReply = (messageId: string) =>
    startReply(async () => {
      if (!reply?.draft.trim()) {
        toast.error("请先生成或填写回复内容");
        return;
      }
      const r = await digestSendReplyAction(periodKey, messageId, reply.draft);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setDisp(messageId, { status: "done" });
      setReply(null);
      toast.success("回复已发送");
      router.refresh();
    });

  return (
    <div className="space-y-4">
      {/* 时间段选择 */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {PERIODS.map((p) => (
            <Link
              key={p.kind}
              href={`/mail/digest?kind=${p.kind}${p.kind === "custom" ? `&from=${customFrom}&to=${customTo}` : p.kind === "since" ? "" : `&day=${day}`}`}
              className={cn("rounded-md border px-2.5 py-1 text-sm hover:bg-muted", p.kind === kind && "border-primary bg-primary/5 font-medium")}
            >
              {p.label}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm">
            {kind !== "since" && kind !== "custom" ? (
              <>
                <Link className="inline-flex size-7 items-center justify-center rounded-md border hover:bg-muted" href={`/mail/digest?kind=${kind}&day=${shift(day, kind, -1)}`} aria-label="上一段">
                  <ChevronLeft className="size-4" />
                </Link>
                <span className="font-medium">{label}</span>
                <Link className="inline-flex size-7 items-center justify-center rounded-md border hover:bg-muted" href={`/mail/digest?kind=${kind}&day=${shift(day, kind, 1)}`} aria-label="下一段">
                  <ChevronRight className="size-4" />
                </Link>
              </>
            ) : kind === "custom" ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="h-8 rounded-md border border-input bg-background px-2 text-sm" />
                <span>至</span>
                <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-8 rounded-md border border-input bg-background px-2 text-sm" />
                <Button size="sm" variant="outline" render={<Link href={`/mail/digest?kind=custom&from=${customFrom}&to=${customTo}`} />}>
                  查看
                </Button>
              </div>
            ) : (
              <span className="font-medium">{label}</span>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={generate} disabled={pending || items.length === 0}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {generated ? "重新生成" : "生成摘要与处理意见"}
          </Button>
        </div>
      </div>

      {props.error ? <p className="text-sm text-destructive">{props.error}</p> : null}

      {/* AI 概览 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            AI 摘要{props.model ? <span className="ml-2 text-xs font-normal text-muted-foreground">{props.model}</span> : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {content ? (
            renderMarkdown(content)
          ) : (
            <p className="text-muted-foreground">
              {items.length === 0 ? "这个时间段还没有经过 AI 分析的邮件。给账号打开「AI 处理」或在 AI 设置里回填后再来看。" : "点右上角「生成摘要与处理意见」，AI 会汇总并给出每封邮件的处理建议。"}
            </p>
          )}
        </CardContent>
      </Card>

      {/* 自然语言调整处理意见 */}
      {generated ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">调整处理意见（自然语言）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              value={nl}
              onChange={(e) => setNl(e.target.value)}
              placeholder="例如：把所有推广邮件退订，给 Bob 的邮件回复说周三下午可以，其余通知类都归档"
              className="min-h-16 text-sm"
            />
            <div className="flex justify-end">
              <Button size="sm" onClick={applyNl} disabled={pending || !nl.trim()}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} 应用调整
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* 邮件与处理意见 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">邮件与处理意见（{items.length}）</CardTitle>
          {generated && selectableIds.length ? (
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => setSelected(e.target.checked ? new Set(selectableIds) : new Set())}
                />
                全选可自动处理
              </label>
              <Button size="sm" onClick={executeSelected} disabled={pending || selected.size === 0}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} 确认并处理（{selected.size}）
              </Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="divide-y p-0 text-sm">
          {items.map((i) => {
            const d = planById.get(i.messageId);
            const done = d?.status === "done";
            const canSelect = d && isAuto(d.action) && !done;
            return (
              <div key={i.messageId} className={cn("space-y-1.5 px-4 py-3", done && "opacity-60")}>
                <div className="flex items-start gap-2">
                  {generated ? (
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={!canSelect}
                      checked={selected.has(i.messageId)}
                      onChange={(e) => toggleSelect(i.messageId, e.target.checked)}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn("rounded px-1 text-[10px]", i.priority === "high" ? "bg-red-100 text-red-700" : "bg-muted text-muted-foreground")}>{i.categoryLabel}</span>
                      {i.needsReply ? <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800">需回复</span> : null}
                      {done ? <span className="rounded bg-emerald-100 px-1 text-[10px] text-emerald-700">已处理</span> : null}
                      <span className="font-medium">{i.from}</span>
                      <Link href={`/mail/${i.accountId}/${i.folderId}?m=${i.messageId}`} className="truncate text-muted-foreground hover:underline">
                        {i.subject ?? "(无主题)"}
                      </Link>
                    </div>
                    {i.summary ? <div className="text-xs text-muted-foreground">{i.summary}</div> : null}

                    {generated ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">处理意见：</span>
                        <select
                          className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
                          value={d?.action ?? "none"}
                          disabled={pending || done}
                          onChange={(e) => changeAction(i.messageId, e.target.value as DigestActionType)}
                        >
                          {DISPOSITION_ORDER.map((a) => (
                            <option key={a} value={a}>
                              {DISPOSITION_LABELS[a]}
                            </option>
                          ))}
                        </select>
                        {d?.reason ? <span className="text-xs text-muted-foreground">— {d.reason}</span> : null}
                        {d?.action === "reply" && (!reply || reply.id !== i.messageId) ? (
                          <Button size="xs" variant="outline" onClick={() => setReply({ id: i.messageId, points: d.replyPoints ?? "", draft: "" })}>
                            写回复
                          </Button>
                        ) : null}
                      </div>
                    ) : null}

                    {/* 回复编辑器 */}
                    {reply && reply.id === i.messageId ? (
                      <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2">
                        <div className="text-xs text-muted-foreground">给出你的主要意见，AI 据此生成回复邮件：</div>
                        <Textarea
                          value={reply.points}
                          onChange={(e) => setReply((s) => (s ? { ...s, points: e.target.value } : s))}
                          placeholder="例如：同意，周三下午 3 点可以；请对方带上合同草稿"
                          className="min-h-12 text-sm"
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button size="xs" onClick={() => generateReply(i.messageId)} disabled={replyPending}>
                            {replyPending ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />} 生成回复
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setReply(null)} disabled={replyPending}>
                            取消
                          </Button>
                        </div>
                        {reply.draft ? (
                          <>
                            <Textarea value={reply.draft} onChange={(e) => setReply((s) => (s ? { ...s, draft: e.target.value } : s))} className="min-h-28 text-sm" />
                            <div className="flex justify-end">
                              <Button size="xs" onClick={() => sendReply(i.messageId)} disabled={replyPending}>
                                {replyPending ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} 发送
                              </Button>
                            </div>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
          {items.length === 0 ? <p className="px-4 py-3 text-muted-foreground">无</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
