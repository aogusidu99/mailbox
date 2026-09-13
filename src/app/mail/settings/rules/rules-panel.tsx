"use client";

import { Loader2, Play, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { CompiledRule } from "@/db/schema";
import type { RulePreviewItem } from "@/server/ai/rules";
import { formatListDate } from "@/lib/format";
import { compileRuleAction, createRuleAction, deleteRuleAction, runRuleNowAction, toggleRuleAction } from "./actions";

export interface RuleRow {
  id: string;
  name: string;
  naturalText: string;
  compiled: CompiledRule;
  enabled: boolean;
  accountId: string | null;
  runCount: number;
  lastRunAt: string | null;
}

const FIELD_LABELS: Record<string, string> = {
  from: "发件人",
  to: "收件人",
  subject: "主题",
  body: "正文",
  category: "AI 分类",
  priority: "AI 优先级",
  hasAttachment: "有附件",
  needsReply: "需要回复",
  listId: "邮件列表",
};
const OP_LABELS: Record<string, string> = {
  contains: "包含",
  not_contains: "不包含",
  equals: "等于",
  starts_with: "开头是",
  ends_with: "结尾是",
  matches: "匹配正则",
  is_true: "为是",
  is_false: "为否",
};
const ACTION_LABELS: Record<string, string> = {
  archive: "归档",
  trash: "删除",
  mark_read: "标为已读",
  mark_unread: "标为未读",
  flag: "加星标",
  junk: "标为垃圾邮件",
  move: "移动到",
  label: "打标签",
};

export function describeRule(r: CompiledRule): string {
  const conds = r.conditions.map((c) => `${FIELD_LABELS[c.field] ?? c.field} ${OP_LABELS[c.op] ?? c.op}${c.value ? `「${c.value}」` : ""}`).join(r.match === "all" ? " 且 " : " 或 ");
  const acts = r.actions.map((a) => `${ACTION_LABELS[a.type] ?? a.type}${a.value ? ` ${a.value}` : ""}`).join("、");
  return `当 ${conds} → ${acts}`;
}

export function RulesPanel({ initialRules, accounts }: { initialRules: RuleRow[]; accounts: Array<{ id: string; email: string }> }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [accountId, setAccountId] = useState<string>("");
  const [draft, setDraft] = useState<{ compiled: CompiledRule; preview: { scanned: number; matches: RulePreviewItem[] } } | null>(null);
  const [pending, start] = useTransition();

  const compile = () =>
    start(async () => {
      const r = await compileRuleAction(text);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setDraft(r.data);
    });

  const save = () =>
    start(async () => {
      if (!draft) return;
      const r = await createRuleAction({ naturalText: text, compiled: draft.compiled, accountId: accountId || null });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("规则已保存，新邮件到达时自动执行");
      setDraft(null);
      setText("");
      router.refresh();
    });

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, success?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "操作失败");
      else if (success) toast.success(success);
      router.refresh();
    });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>新建规则</CardTitle>
          <CardDescription>例如：「把所有发票和账单邮件归档到 Finance」「来自 newsletter 的邮件标为已读」「主题包含『面试』的邮件加星标」</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea aria-label="规则描述" value={text} onChange={(e) => setText(e.target.value)} placeholder="用一句话描述规则…" className="min-h-20" />
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="适用账号" className="h-8 rounded-lg border border-input bg-background px-2 text-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">所有邮箱</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
            <Button onClick={compile} disabled={pending || !text.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} 用 AI 编译并预览
            </Button>
          </div>

          {draft ? (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <div className="font-medium">{draft.compiled.name}</div>
              <div className="text-muted-foreground">{describeRule(draft.compiled)}</div>
              <div className="text-xs text-muted-foreground">
                在最近 {draft.preview.scanned} 封收件箱邮件里试算，命中 {draft.preview.matches.length} 封：
              </div>
              <ul className="max-h-48 space-y-0.5 overflow-auto text-xs">
                {draft.preview.matches.slice(0, 50).map((m) => (
                  <li key={m.messageId}>
                    <Link href={`/mail/${m.accountId}/${m.folderId}?m=${m.messageId}`} className="hover:underline">
                      {formatListDate(m.date)} {m.from}：{m.subject ?? "(无主题)"}
                    </Link>
                  </li>
                ))}
                {draft.preview.matches.length === 0 ? <li className="text-muted-foreground">（没有命中，规则仍可保存，之后的新邮件会匹配）</li> : null}
              </ul>
              <div className="flex gap-2">
                <Button size="sm" onClick={save} disabled={pending}>
                  保存规则
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={pending}>
                  放弃
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>已有规则（{initialRules.length}）</CardTitle>
          <CardDescription>按创建顺序依次匹配；「立即执行」会对最近 300 封收件箱邮件应用该规则。</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {initialRules.length === 0 ? <p className="py-3 text-sm text-muted-foreground">还没有规则。</p> : null}
          {initialRules.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{r.name}</div>
                <div className="text-xs text-muted-foreground">「{r.naturalText}」</div>
                <div className="text-xs text-muted-foreground">{describeRule(r.compiled)}</div>
                <div className="text-xs text-muted-foreground">
                  {r.accountId ? accounts.find((a) => a.id === r.accountId)?.email ?? "指定邮箱" : "所有邮箱"} · 已执行 {r.runCount} 次
                  {r.lastRunAt ? ` · 最近 ${formatListDate(r.lastRunAt)}` : ""}
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                启用
                <Switch checked={r.enabled} disabled={pending} onCheckedChange={(v) => act(() => toggleRuleAction(r.id, Boolean(v)))} />
              </label>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => act(async () => { const res = await runRuleNowAction(r.id); if (res.ok) toast.success(`已对 ${res.data.applied} 封邮件执行`); return res; })}>
                <Play className="size-4" /> 立即执行
              </Button>
              <Button size="sm" variant="destructive" disabled={pending} aria-label={`删除规则 ${r.name}`} onClick={() => act(() => deleteRuleAction(r.id), "已删除")}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
