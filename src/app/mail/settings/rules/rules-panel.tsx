"use client";

import { Brain, ChevronDown, ChevronRight, Loader2, Pencil, Play, Sparkles, Trash2, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { CompiledRule } from "@/db/schema";
import type { RulePreviewItem } from "@/server/ai/rules";
import { formatListDate } from "@/lib/format";
import { compileRulesAction, createRuleAction, createRulesAction, deleteRuleAction, draftStrongRulesAction, editRuleAction, previewRuleAction, runAllRulesAction, runRuleNowAction, suggestStrongRulesAction, toggleRuleAction } from "./actions";
import { BLANK_RULE, RuleEditor } from "./rule-editor";

type BatchDraft = { scanned: number; items: Array<{ naturalText: string; compiled: CompiledRule; matchCount: number }>; errors: Array<{ line: string; error: string }> };

export interface RuleRow {
  id: string;
  name: string;
  naturalText: string;
  compiled: CompiledRule;
  enabled: boolean;
  accountIds: string[]; // 有效适用账号（空数组 = 所有邮箱）
  runCount: number;
  lastRunAt: string | null;
  createdAt: string | null;
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
  assistant: "转给助手",
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

// ---- 筛选 / 分类 / 排序（纯前端，针对「已有规则」列表）----
const SELECT_CLS = "h-8 rounded-lg border border-input bg-background px-2 text-sm";
const GLOBAL_ACCOUNT = "__global__"; // 适用邮箱筛选里代表「通用（所有邮箱）」的哨兵值
type RuleTypeKey = "strong" | "ai";
type SortKey = "default" | "name" | "runs" | "recent" | "created";
type GroupKey = "none" | "type" | "account" | "action";

/** 这条规则包含的所有动作类型 */
function ruleActionTypes(r: CompiledRule): string[] {
  return r.actions.map((a) => a.type);
}
/** 规则的主要动作（取第一个），用于「按动作分类」分组 */
function primaryAction(r: CompiledRule): string {
  return r.actions[0]?.type ?? "";
}
/** 规则是否对某账号生效：空 = 所有邮箱（含该账号），否则看是否在列表里 */
function ruleAppliesToAccountClient(accountIds: string[], want: string): boolean {
  return accountIds.length === 0 || accountIds.includes(want);
}
/** 某动作类型在规则里出现时的目标值（move=文件夹、label=标签），用于动作二级筛选 */
function ruleActionValues(r: CompiledRule, type: string): string[] {
  return r.actions.filter((a) => a.type === type && (a.value ?? "") !== "").map((a) => a.value as string);
}

/** 适用邮箱多选：勾选的账号 id 列表（都不勾 = 对所有邮箱生效） */
function AccountMultiSelect({ accounts, value, onChange }: { accounts: Array<{ id: string; email: string }>; value: string[]; onChange: (ids: string[]) => void }) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-input bg-background px-2 py-1.5">
      <span className="text-xs text-muted-foreground">适用邮箱：</span>
      {accounts.map((a) => (
        <label key={a.id} className="flex items-center gap-1 text-xs">
          <input type="checkbox" className="size-3.5" checked={value.includes(a.id)} onChange={() => toggle(a.id)} />
          {a.email}
        </label>
      ))}
      <span className="text-[11px] text-muted-foreground">{value.length === 0 ? "（都不勾 = 所有邮箱）" : `已选 ${value.length} 个`}</span>
    </div>
  );
}

export function RulesPanel({ initialRules, accounts }: { initialRules: RuleRow[]; accounts: Array<{ id: string; email: string }> }) {
  const router = useRouter();
  const [manualAccountIds, setManualAccountIds] = useState<string[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null); // null=新建，非空=编辑已有规则
  const [draftRule, setDraftRule] = useState<CompiledRule | null>(null);
  const [preview, setPreview] = useState<{ scanned: number; matches: RulePreviewItem[] } | null>(null);
  const [pending, start] = useTransition();
  // AI 新建（每行一句，可一次多条）
  const [batchText, setBatchText] = useState("");
  const [batchAccountIds, setBatchAccountIds] = useState<string[]>([]);
  const [batchDraft, setBatchDraft] = useState<BatchDraft | null>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  // 「已有规则」列表的筛选 / 排序 / 分组（规则多时用来快速定位）
  const [q, setQ] = useState("");
  const [fAccount, setFAccount] = useState("");
  const [fType, setFType] = useState<"" | RuleTypeKey>("");
  const [fAction, setFAction] = useState("");
  const [fActionValue, setFActionValue] = useState(""); // 动作二级筛选：如「移动到」具体哪个文件夹
  const [fStatus, setFStatus] = useState<"" | "on" | "off">("");
  const [sortKey, setSortKey] = useState<SortKey>("default");
  const [groupKey, setGroupKey] = useState<GroupKey>("none");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()); // 已折叠的分组 key
  const [runScope, setRunScope] = useState<"all" | "inbox">("all"); // 全部立即执行的范围：含已分类纠错 / 只收件箱

  // 适用邮箱标签：空=所有邮箱；单个=邮箱名；多个=逗号拼接
  const accountScopeLabel = useCallback((ids: string[]) => (ids.length === 0 ? "所有邮箱" : ids.map((id) => accounts.find((a) => a.id === id)?.email ?? "已删除账号").join("、")), [accounts]);
  const filtersActive = Boolean(q.trim() || fAccount || fType || fAction || fActionValue || fStatus);
  const clearFilters = () => { setQ(""); setFAccount(""); setFType(""); setFAction(""); setFActionValue(""); setFStatus(""); };
  // 动作二级选项：当前所选动作在所有规则里出现过的目标值（文件夹 / 标签），去重
  const actionValueOptions = useMemo(() => {
    if (fAction !== "move" && fAction !== "label") return [];
    return [...new Set(initialRules.flatMap((r) => ruleActionValues(r.compiled, fAction)))].sort((a, b) => a.localeCompare(b, "zh"));
  }, [initialRules, fAction]);

  // 筛选 → 排序 → 分组。describeRule 参与搜索，便于按动作/文件夹名找规则。
  const groups = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const filtered = initialRules.filter((r) => {
      if (fAccount) {
        if (fAccount === GLOBAL_ACCOUNT) {
          if (r.accountIds.length !== 0) return false; // 只看「所有邮箱」通用规则
        } else if (!ruleAppliesToAccountClient(r.accountIds, fAccount)) {
          return false; // 选单一邮箱 → 对它生效的都算（含通用的、含多邮箱里有它的）
        }
      }
      if (fType && (fType === "strong") !== isStrongRuleClient(r.compiled)) return false;
      if (fAction && !ruleActionTypes(r.compiled).includes(fAction)) return false;
      if (fActionValue && !ruleActionValues(r.compiled, fAction).includes(fActionValue)) return false; // 二级：移动到/标签 的具体目标
      if (fStatus && (fStatus === "on") !== r.enabled) return false;
      if (kw) {
        const hay = `${r.name}\n${r.naturalText}\n${describeRule(r.compiled)}\n${accountScopeLabel(r.accountIds)}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    const sorted = [...filtered];
    if (sortKey === "name") sorted.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    else if (sortKey === "runs") sorted.sort((a, b) => b.runCount - a.runCount);
    else if (sortKey === "recent") sorted.sort((a, b) => (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""));
    else if (sortKey === "created") sorted.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    // "default" 保持 listRules 的返回顺序（createdAt 升序）

    if (groupKey === "none") return [{ key: "", label: "", rules: sorted }];
    const map = new Map<string, { key: string; label: string; rules: RuleRow[] }>();
    for (const r of sorted) {
      let key: string;
      let label: string;
      if (groupKey === "type") { const s = isStrongRuleClient(r.compiled); key = s ? "strong" : "ai"; label = s ? "强规则" : "AI 规则"; }
      else if (groupKey === "account") { label = accountScopeLabel(r.accountIds); key = r.accountIds.length === 0 ? GLOBAL_ACCOUNT : [...r.accountIds].sort().join(","); }
      else { const a = primaryAction(r.compiled); key = a || "none"; label = ACTION_LABELS[a] ?? a ?? "（无动作）"; }
      if (!map.has(key)) map.set(key, { key, label, rules: [] });
      map.get(key)!.rules.push(r);
    }
    return [...map.values()];
  }, [initialRules, accountScopeLabel, q, fAccount, fType, fAction, fActionValue, fStatus, sortKey, groupKey]);

  const shownCount = groups.reduce((n, g) => n + g.rules.length, 0);
  // 分组折叠：点标题行折叠/展开单组；「全部折叠/展开」一键切换
  const toggleGroup = (key: string) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.key));
  const toggleAllGroups = () => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.key)));

  // 手动新建「确定规则」弹窗（结构化编辑，不依赖 AI 分类）
  const openManual = () => {
    setEditingRuleId(null);
    setManualAccountIds([]);
    setDraftRule(JSON.parse(JSON.stringify(BLANK_RULE)) as CompiledRule);
    setPreview(null);
    setManualOpen(true);
  };
  // 编辑已保存的规则：同一个弹窗，载入这条规则的条件 / 动作 / 适用邮箱
  const openEdit = (r: RuleRow) => {
    setEditingRuleId(r.id);
    setManualAccountIds(r.accountIds);
    setDraftRule(JSON.parse(JSON.stringify(r.compiled)) as CompiledRule);
    setPreview(null);
    setManualOpen(true);
  };
  const closeManual = () => {
    setManualOpen(false);
    setEditingRuleId(null);
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
      const r = editingRuleId
        ? await editRuleAction({ ruleId: editingRuleId, compiled: draftRule, naturalText: describeRule(draftRule), accountIds: manualAccountIds })
        : await createRuleAction({ naturalText: describeRule(draftRule), compiled: draftRule, accountIds: manualAccountIds });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(editingRuleId ? "规则已更新" : "规则已保存，新邮件到达时自动执行");
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

  // 把整段文字当「目标」，让 AI 读邮箱（真实发件人/域名）来起草强规则——解决"域名在邮箱里、不在句子里"的情况
  const draftRules = () =>
    start(async () => {
      const t = batchText.trim();
      if (!t) {
        toast.error("请先在上面的输入框里描述你想要的规则目标");
        return;
      }
      const r = await draftStrongRulesAction(t, batchAccountIds);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.data.items.length === 0) {
        toast.info("没能据此起草出规则——可能描述里提到的发件人 / 域名在邮箱里没找到，换个说法或点名具体发件人再试");
        return;
      }
      setEditingIdx(null);
      setBatchDraft(r.data);
      toast.success(`AI 起草了 ${r.data.items.length} 条强规则，请审核`);
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
      const r = await createRulesAction({ items: batchDraft.items.map((it) => ({ naturalText: it.naturalText, compiled: it.compiled })), accountIds: batchAccountIds });
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
          <CardDescription>
            两种 AI 方式：<br />
            ·「<strong>用 AI 编译并预览</strong>」：每行一句、按你写的条件直接编译（适合自带条件的，如「把推广类邮件归档」「发件人是 xxx 的移动到 Finance」）。<br />
            ·「<strong>AI 起草强规则</strong>」：把整段当<strong>目标</strong>，AI <strong>读你的邮箱</strong>找到真实发件人 / 域名来起草（适合「来自<strong>这个学校</strong>的邮件都放进 Important」这类——真实域名在邮箱里、不在句子里，普通编译只会猜错）。<br />
            两者结果都<strong>可逐条审核、修改、重新试算</strong>再保存。也可「手动新建」用表单从零建；用一阵后点「<strong>总结强规则</strong>」按邮件现在都分到哪了自动归纳补漏。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            aria-label="规则（每行一条）"
            value={batchText}
            onChange={(e) => setBatchText(e.target.value)}
            placeholder={"把推广广告(promotion)类邮件移动到 Promotion 文件夹\n把订阅资讯(newsletter)类邮件移动到 Newsletter 文件夹\n把账单发票(billing)类邮件移动到 Finance 文件夹\n把重要且优先级高的邮件加星标\n把待办(todo)类邮件加星标并转给助手"}
            className="min-h-32 font-mono text-sm"
          />
          <AccountMultiSelect accounts={accounts} value={batchAccountIds} onChange={setBatchAccountIds} />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={compileBatch} disabled={pending || !batchText.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} 用 AI 编译并预览
            </Button>
            <Button variant="outline" onClick={draftRules} disabled={pending || !batchText.trim()} title="把整段文字当目标，AI 读你的邮箱找到真实发件人/域名来起草强规则（适合「来自某学校/某人的邮件都放进某文件夹」这类——域名在邮箱里、不在句子里）">
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Brain className="size-4" />} AI 起草强规则
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
              <div className="text-xs text-muted-foreground">在最近 {batchDraft.scanned} 封邮件（收件箱 + 各分类文件夹）里试算：</div>
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
            <CardTitle>已有规则（{filtersActive ? `${shownCount} / ${initialRules.length}` : initialRules.length}）</CardTitle>
            <CardDescription><strong>强规则优先</strong>执行、AI 规则兜底；某封被强规则归档 / 移动后，AI 规则不再重复处理它。新邮件到达时<strong>只处理收件箱</strong>、不动已分类的。手动「全部立即执行」可选范围：<strong>含已分类文件夹（纠错）</strong>——把错分的邮件捞回；或<strong>只收件箱（日常）</strong>。</CardDescription>
          </div>
          {initialRules.length ? (
            <div className="flex items-center gap-2">
              <select aria-label="执行范围" className={SELECT_CLS} value={runScope} onChange={(e) => setRunScope(e.target.value as "all" | "inbox")} disabled={pending}>
                <option value="all">含已分类文件夹（纠错）</option>
                <option value="inbox">只收件箱（日常）</option>
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  const msg =
                    runScope === "all"
                      ? "对最近约 1000 封邮件（收件箱 + 各分类文件夹）跑一遍所有启用的规则？强规则优先、会把错分的邮件移到正确文件夹；移动 / 归档 / 删除等立即执行。"
                      : "对最近约 1000 封收件箱邮件跑一遍所有启用的规则？不会动已分类文件夹里的邮件；移动 / 归档 / 删除等立即执行。";
                  if (!confirm(msg)) return;
                  act(async () => {
                    const res = await runAllRulesAction(runScope);
                    if (res.ok) toast.success(`扫描 ${res.data.scanned} 封，命中执行 ${res.data.applied} 次`);
                    return res;
                  });
                }}
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} 全部立即执行
              </Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {initialRules.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">还没有规则。</p>
          ) : (
            <>
              {/* 筛选 / 排序 / 分类工具条——规则多时用来快速定位 */}
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2">
                <input
                  type="search"
                  aria-label="搜索规则"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="搜索名称 / 条件 / 文件夹…"
                  className="h-8 min-w-40 flex-1 rounded-lg border border-input bg-background px-2 text-sm"
                />
                <select aria-label="适用邮箱" className={SELECT_CLS} value={fAccount} onChange={(e) => setFAccount(e.target.value)}>
                  <option value="">全部邮箱</option>
                  <option value={GLOBAL_ACCOUNT}>通用（所有邮箱）</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.email}</option>
                  ))}
                </select>
                <select aria-label="规则类型" className={SELECT_CLS} value={fType} onChange={(e) => setFType(e.target.value as "" | RuleTypeKey)}>
                  <option value="">全部类型</option>
                  <option value="strong">强规则</option>
                  <option value="ai">AI 规则</option>
                </select>
                <select aria-label="动作类型" className={SELECT_CLS} value={fAction} onChange={(e) => { setFAction(e.target.value); setFActionValue(""); }}>
                  <option value="">全部动作</option>
                  {Object.entries(ACTION_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
                {actionValueOptions.length ? (
                  <select aria-label={fAction === "move" ? "移动到哪个文件夹" : "哪个标签"} className={SELECT_CLS} value={fActionValue} onChange={(e) => setFActionValue(e.target.value)}>
                    <option value="">{fAction === "move" ? "全部文件夹" : "全部标签"}</option>
                    {actionValueOptions.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                ) : null}
                <select aria-label="启用状态" className={SELECT_CLS} value={fStatus} onChange={(e) => setFStatus(e.target.value as "" | "on" | "off")}>
                  <option value="">全部状态</option>
                  <option value="on">已启用</option>
                  <option value="off">已停用</option>
                </select>
                <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                <select aria-label="排序方式" className={SELECT_CLS} value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                  <option value="default">默认顺序</option>
                  <option value="name">按名称</option>
                  <option value="runs">按执行次数</option>
                  <option value="recent">按最近执行</option>
                  <option value="created">按最近新建</option>
                </select>
                <select aria-label="分类方式" className={SELECT_CLS} value={groupKey} onChange={(e) => setGroupKey(e.target.value as GroupKey)}>
                  <option value="none">不分类</option>
                  <option value="type">按类型分类</option>
                  <option value="account">按邮箱分类</option>
                  <option value="action">按动作分类</option>
                </select>
                {groupKey !== "none" && shownCount > 0 ? (
                  <Button size="xs" variant="ghost" onClick={toggleAllGroups}>{allCollapsed ? "全部展开" : "全部折叠"}</Button>
                ) : null}
                {filtersActive ? (
                  <Button size="xs" variant="ghost" onClick={clearFilters}>清除筛选</Button>
                ) : null}
              </div>

              {shownCount === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">没有符合条件的规则。<button type="button" className="text-primary hover:underline" onClick={clearFilters}>清除筛选</button></p>
              ) : (
                groups.map((g) => (
                  <div key={g.key || "all"}>
                    {groupKey !== "none" ? (
                      <button type="button" onClick={() => toggleGroup(g.key)} className="mb-1 flex w-full items-center gap-2 border-b pb-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
                        {collapsed.has(g.key) ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                        <span>{g.label || "（无动作）"}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5">{g.rules.length}</span>
                      </button>
                    ) : null}
                    <div className="divide-y">
                      {(groupKey === "none" || !collapsed.has(g.key)) && g.rules.map((r) => (
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
                              {accountScopeLabel(r.accountIds)} · 已执行 {r.runCount} 次
                              {r.lastRunAt ? ` · 最近 ${formatListDate(r.lastRunAt)}` : ""}
                            </div>
                          </div>
                          <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            启用
                            <Switch checked={r.enabled} disabled={pending} onCheckedChange={(v) => act(() => toggleRuleAction(r.id, Boolean(v)))} />
                          </label>
                          <Button size="sm" variant="outline" disabled={pending} aria-label={`编辑规则 ${r.name}`} onClick={() => openEdit(r)}>
                            <Pencil className="size-4" /> 编辑
                          </Button>
                          <Button size="sm" variant="outline" disabled={pending} onClick={() => act(async () => { const res = await runRuleNowAction(r.id); if (res.ok) toast.success(`已对 ${res.data.applied} 封邮件执行`); return res; })}>
                            <Play className="size-4" /> 立即执行
                          </Button>
                          <Button size="sm" variant="destructive" disabled={pending} aria-label={`删除规则 ${r.name}`} onClick={() => act(() => deleteRuleAction(r.id), "已删除")}>
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* 结构化编辑器弹窗：新建 / 编辑共用 */}
      <Dialog open={manualOpen} onOpenChange={(o) => (o ? setManualOpen(true) : closeManual())}>
        <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingRuleId ? "编辑规则" : "手动新建确定规则"}</DialogTitle>
            <DialogDescription>精确设定条件与动作（如 发件人 包含 X → 移动到某文件夹）。{editingRuleId ? "改完点「保存规则」即更新这条。" : "不依赖 AI 分类、不会出错。"}</DialogDescription>
          </DialogHeader>
          {draftRule ? (
            <div className="space-y-3">
              <RuleEditor value={draftRule} onChange={setDraftRule} />
              <AccountMultiSelect accounts={accounts} value={manualAccountIds} onChange={setManualAccountIds} />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={rePreview} disabled={pending}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null} 试算命中
                </Button>
                <Button size="sm" onClick={save} disabled={pending}>
                  {editingRuleId ? "更新规则" : "保存规则"}
                </Button>
                <Button size="sm" variant="ghost" onClick={closeManual} disabled={pending}>
                  取消
                </Button>
              </div>
              {preview ? (
                <div className="space-y-1 rounded-md border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">在最近 {preview.scanned} 封邮件（收件箱 + 各分类文件夹）里试算，命中 {preview.matches.length} 封：</div>
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
