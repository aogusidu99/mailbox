"use client";

import { Loader2, Play, Sparkles, Trash2, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { CompiledRule } from "@/db/schema";
import type { RulePreviewItem } from "@/server/ai/rules";
import { formatListDate } from "@/lib/format";
import { compileRulesAction, createRuleAction, createRulesAction, deleteRuleAction, previewRuleAction, runAllRulesAction, runRuleNowAction, suggestStrongRulesAction, toggleRuleAction } from "./actions";
import { BLANK_RULE, RuleEditor } from "./rule-editor";

type BatchDraft = { scanned: number; items: Array<{ naturalText: string; compiled: CompiledRule; matchCount: number }>; errors: Array<{ line: string; error: string }> };

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

const AI_FIELDS = new Set<string>(["category", "priority", "needsReply"]);
/** 强规则（确定规则）：条件不含 AI 分类/优先级/需回复，优先于 AI 规则执行 */
function isStrongRuleClient(r: CompiledRule): boolean {
  return r.conditions.length > 0 && !r.conditions.some((c) => AI_FIELDS.has(c.field));
}

export function RulesPanel({ initialRules, accounts }: { initialRules: RuleRow[]; accounts: Array<{ id: string; email: string }> }) {
  const router = useRouter();
  const [accountId, setAccountId] = useState<string>("");
  const [manualOpen, setManualOpen] = useState(false);
  const [draftRule, setDraftRule] = useState<CompiledRule | null>(null);
  const [preview, setPreview] = useState<{ scanned: number; matches: RulePreviewItem[] } | null>(null);
  const [pending, start] = useTransition();
  // AI 新建（每行一句，可一次多条）
  const [batchText, setBatchText] = useState("");
  const [batchAccountId, setBatchAccountId] = useState<string>("");
  const [batchDraft, setBatchDraft] = useState<BatchDraft | null>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  // 手动新建「确定规则」弹窗（结构化编辑，不依赖 AI 分类）
  const openManual = () => {
    setDraftRule(JSON.parse(JSON.stringify(BLANK_RULE)) as CompiledRule);
    setPreview(null);
    setManualOpen(true);
  };
  const closeManual = () => {
    setManualOpen(false);
    setDraftRule(null);
    setPreview(null);
  };

  // 改过条件/动作后重新试算命中
  const rePreview = () =>
    start(async () => {
      if (!draftRule) return;
      const r = await previewRuleAction(draftRule);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setPreview(r.data);
    });

  const save = () =>
    start(async () => {
      if (!draftRule) return;
      const r = await createRuleAction({ naturalText: describeRule(draftRule), compiled: draftRule, accountId: accountId || null });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("规则已保存，新邮件到达时自动执行");
      closeManual();
      router.refresh();
    });

  const compileBatch = () =>
    start(async () => {
      const r = await compileRulesAction(batchText);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setEditingIdx(null);
      setBatchDraft(r.data);
    });

  // 从现有邮件分布归纳强规则建议（按发件人→文件夹），结果进入下方审核区
  const suggestRules = () =>
    start(async () => {
      const r = await suggestStrongRulesAction();
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.data.items.length === 0) {
        toast.info("暂时没归纳出规律——先让 AI 规则多分一些邮件（或点「全部立即执行」）再试");
        return;
      }
      setEditingIdx(null);
      setBatchDraft(r.data);
      toast.success(`归纳出 ${r.data.items.length} 条候选强规则，请审核`);
    });

  const removeBatchItem = (i: number) => setBatchDraft((d) => (d ? { ...d, items: d.items.filter((_, j) => j !== i) } : d));
  // 审核时逐条修改 AI 编译出的规则
  const updateBatchItem = (i: number, compiled: CompiledRule) => setBatchDraft((d) => (d ? { ...d, items: d.items.map((it, j) => (j === i ? { ...it, compiled } : it)) } : d));
  const rePreviewBatchItem = (i: number) =>
    start(async () => {
      if (!batchDraft) return;
      const r = await previewRuleAction(batchDraft.items[i].compiled);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setBatchDraft((d) => (d ? { ...d, items: d.items.map((it, j) => (j === i ? { ...it, matchCount: r.data.matches.length } : it)) } : d));
    });

  const saveBatch = () =>
    start(async () => {
      if (!batchDraft || batchDraft.items.length === 0) return;
      const r = await createRulesAction({ items: batchDraft.items.map((it) => ({ naturalText: it.naturalText, compiled: it.compiled })), accountId: batchAccountId || null });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`已保存 ${r.data.created} 条规则`);
      setBatchDraft(null);
      setBatchText("");
      router.refresh();
    });

  // 只重试「没编译成功」的那几行，结果并入当前草稿——不用重跑整批
  const retryFailed = () =>
    start(async () => {
      if (!batchDraft || batchDraft.errors.length === 0) return;
      const r = await compileRulesAction(batchDraft.errors.map((e) => e.line).join("\n"));
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setBatchDraft((d) => (d ? { scanned: r.data.scanned || d.scanned, items: [...d.items, ...r.data.items], errors: r.data.errors } : r.data));
      if (r.data.items.length) toast.success(`又成功 ${r.data.items.length} 条`);
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
          <CardTitle>新建规则（自然语言，可批量）</CardTitle>
          <CardDescription>每行一句话描述——<strong>AI 规则</strong>（按分类，如「把推广类邮件归档」）和<strong>强规则</strong>（确定条件，如「发件人是 xxx 的邮件移动到 Finance」）都写在这里，AI 一次编译成规则（空行、# 注释行跳过）。编译后<strong>可逐条审核、修改、重新试算</strong>，满意再全部保存。也可点「手动新建」用表单从零建；用一阵后点「<strong>总结强规则</strong>」，按邮件现在都分到哪了自动归纳出按发件人的强规则来补漏。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            aria-label="规则（每行一条）"
            value={batchText}
            onChange={(e) => setBatchText(e.target.value)}
            placeholder={"把推广广告(promotion)类邮件移动到 Promotion 文件夹\n把订阅资讯(newsletter)类邮件移动到 Newsletter 文件夹\n把账单发票(billing)类邮件移动到 Finance 文件夹\n把重要且优先级高的邮件加星标\n把待办(todo)类邮件加星标并转给助手"}
            className="min-h-32 font-mono text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="适用账号" className="h-8 rounded-lg border border-input bg-background px-2 text-sm" value={batchAccountId} onChange={(e) => setBatchAccountId(e.target.value)}>
              <option value="">所有邮箱</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
            <Button onClick={compileBatch} disabled={pending || !batchText.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} 用 AI 编译并预览
            </Button>
            <Button variant="outline" onClick={openManual} disabled={pending}>
              手动新建（表单）
            </Button>
            <Button variant="outline" onClick={suggestRules} disabled={pending} title="分析邮件现在都分到了哪，归纳出按发件人的强规则来补漏">
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} 总结强规则
            </Button>
          </div>

          {batchDraft ? (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              {batchDraft.errors.length ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                  {batchDraft.errors.length} 行没编译成功（已跳过）：
                  <ul className="mt-1 list-disc pl-4">
                    {batchDraft.errors.map((e, i) => (
                      <li key={i}>「{e.line}」— {e.error}</li>
                    ))}
                  </ul>
                  <Button size="xs" variant="outline" onClick={retryFailed} disabled={pending} className="mt-2">
                    {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} 重试这 {batchDraft.errors.length} 行
                  </Button>
                </div>
              ) : null}
              <div className="text-xs text-muted-foreground">在最近 {batchDraft.scanned} 封收件箱邮件里试算：</div>
              <div className="divide-y rounded-md border">
                {batchDraft.items.map((it, i) => (
                  <div key={i} className="p-2">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">
                          {it.compiled.name}
                          <span className={`ml-2 rounded px-1 text-[10px] font-normal ${isStrongRuleClient(it.compiled) ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
                            {isStrongRuleClient(it.compiled) ? "强规则" : "AI 规则"}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">{describeRule(it.compiled)}</div>
                        {it.naturalText ? <div className="text-[11px] text-muted-foreground/80">{it.naturalText}</div> : null}
                        <div className="text-xs text-muted-foreground">命中 {it.matchCount} 封</div>
                      </div>
                      <Button size="xs" variant="ghost" onClick={() => setEditingIdx(editingIdx === i ? null : i)} disabled={pending}>
                        {editingIdx === i ? "收起" : "编辑"}
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => { removeBatchItem(i); if (editingIdx === i) setEditingIdx(null); }} disabled={pending}>
                        移除
                      </Button>
                    </div>
                    {editingIdx === i ? (
                      <div className="mt-2 space-y-2">
                        <RuleEditor value={it.compiled} onChange={(c) => updateBatchItem(i, c)} />
                        <Button size="xs" variant="outline" onClick={() => rePreviewBatchItem(i)} disabled={pending}>
                          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} 重新试算
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
                {batchDraft.items.length === 0 ? <div className="p-2 text-xs text-muted-foreground">没有可保存的规则。</div> : null}
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveBatch} disabled={pending || batchDraft.items.length === 0}>
                  全部保存（{batchDraft.items.length}）
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setBatchDraft(null)} disabled={pending}>
                  放弃
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>已有规则（{initialRules.length}）</CardTitle>
            <CardDescription><strong>强规则优先</strong>执行、AI 规则兜底；某封被强规则归档 / 移动后，AI 规则不再重复处理它。「立即执行 / 全部立即执行」会对最近 300 封收件箱邮件（含已分类的）重新判断。</CardDescription>
          </div>
          {initialRules.length ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                if (!confirm("对每个账号最近 300 封收件箱邮件跑一遍所有启用的规则？移动 / 归档 / 删除等会立即执行。")) return;
                act(async () => {
                  const res = await runAllRulesAction();
                  if (res.ok) toast.success(`扫描 ${res.data.scanned} 封，命中执行 ${res.data.applied} 次`);
                  return res;
                });
              }}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} 全部立即执行
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="divide-y">
          {initialRules.length === 0 ? <p className="py-3 text-sm text-muted-foreground">还没有规则。</p> : null}
          {initialRules.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {r.name}
                  <span className={`ml-2 rounded px-1 text-[10px] font-normal ${isStrongRuleClient(r.compiled) ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
                    {isStrongRuleClient(r.compiled) ? "强规则" : "AI 规则"}
                  </span>
                </div>
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

      {/* 手动新建确定规则：结构化编辑器弹窗 */}
      <Dialog open={manualOpen} onOpenChange={(o) => (o ? setManualOpen(true) : closeManual())}>
        <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>手动新建确定规则</DialogTitle>
            <DialogDescription>精确设定条件与动作（如 发件人 包含 X → 移动到某文件夹），不依赖 AI 分类、不会出错。</DialogDescription>
          </DialogHeader>
          {draftRule ? (
            <div className="space-y-3">
              <RuleEditor value={draftRule} onChange={setDraftRule} />
              <div className="flex flex-wrap items-center gap-2">
                <select aria-label="适用账号" className="h-8 rounded-lg border border-input bg-background px-2 text-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  <option value="">所有邮箱</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.email}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="outline" onClick={rePreview} disabled={pending}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null} 试算命中
                </Button>
                <Button size="sm" onClick={save} disabled={pending}>
                  保存规则
                </Button>
                <Button size="sm" variant="ghost" onClick={closeManual} disabled={pending}>
                  取消
                </Button>
              </div>
              {preview ? (
                <div className="space-y-1 rounded-md border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">在最近 {preview.scanned} 封收件箱邮件里试算，命中 {preview.matches.length} 封：</div>
                  <ul className="max-h-48 space-y-0.5 overflow-auto text-xs">
                    {preview.matches.slice(0, 50).map((m) => (
                      <li key={m.messageId}>
                        <Link href={`/mail/${m.accountId}/${m.folderId}?m=${m.messageId}`} className="hover:underline">
                          {formatListDate(m.date)} {m.from}：{m.subject ?? "(无主题)"}
                        </Link>
                      </li>
                    ))}
                    {preview.matches.length === 0 ? <li className="text-muted-foreground">（没有命中，规则仍可保存，之后的新邮件会匹配）</li> : null}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
