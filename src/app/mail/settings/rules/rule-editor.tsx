"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CompiledRule, RuleAction, RuleCondition } from "@/db/schema";

/** 规则结构化编辑器：AI 生成后可改，也可手动从零建「确定规则」（发件人/主题等，不依赖 AI 分类）。 */

const selectCls = "h-8 rounded-md border border-input bg-background px-2 text-sm";

const FIELDS: Array<{ v: RuleCondition["field"]; label: string; kind: "text" | "category" | "priority" | "bool" }> = [
  { v: "from", label: "发件人", kind: "text" },
  { v: "to", label: "收件人", kind: "text" },
  { v: "subject", label: "主题", kind: "text" },
  { v: "body", label: "正文", kind: "text" },
  { v: "listId", label: "邮件列表 ID", kind: "text" },
  { v: "category", label: "AI 分类", kind: "category" },
  { v: "priority", label: "AI 优先级", kind: "priority" },
  { v: "hasAttachment", label: "有附件", kind: "bool" },
  { v: "needsReply", label: "需要回复", kind: "bool" },
];
const TEXT_OPS: Array<[RuleCondition["op"], string]> = [
  ["contains", "包含"],
  ["not_contains", "不包含"],
  ["equals", "等于"],
  ["starts_with", "开头是"],
  ["ends_with", "结尾是"],
  ["matches", "匹配正则"],
];
const BOOL_OPS: Array<[RuleCondition["op"], string]> = [
  ["is_true", "是"],
  ["is_false", "否"],
];
const CATEGORIES: Array<[string, string]> = [
  ["important", "重要"],
  ["todo", "待办"],
  ["notification", "通知"],
  ["billing", "账单/发票"],
  ["newsletter", "订阅资讯"],
  ["promotion", "推广"],
  ["social", "社交"],
  ["personal", "个人"],
  ["other", "其它"],
];
const PRIORITIES: Array<[string, string]> = [
  ["high", "高"],
  ["normal", "普通"],
  ["low", "低"],
];
const ACTIONS: Array<[RuleAction["type"], string]> = [
  ["archive", "归档"],
  ["flag", "加星标"],
  ["mark_read", "标为已读"],
  ["mark_unread", "标为未读"],
  ["move", "移动到…"],
  ["label", "打标签(Gmail)…"],
  ["junk", "标为垃圾"],
  ["trash", "删除"],
  ["assistant", "转给助手"],
];
const VALUE_ACTIONS = new Set<RuleAction["type"]>(["move", "label"]);

function kindOf(field: RuleCondition["field"]) {
  return FIELDS.find((f) => f.v === field)?.kind ?? "text";
}

/** 手动新建时的空白规则：发件人包含 X → 移动到某文件夹（典型的确定规则） */
export const BLANK_RULE: CompiledRule = { name: "新规则", match: "all", conditions: [{ field: "from", op: "contains", value: "" }], actions: [{ type: "move", value: "" }], stopProcessing: false };

export function RuleEditor({ value, onChange }: { value: CompiledRule; onChange: (r: CompiledRule) => void }) {
  const setConds = (conditions: RuleCondition[]) => onChange({ ...value, conditions });
  const setActions = (actions: RuleAction[]) => onChange({ ...value, actions });
  const updateCond = (i: number, patch: Partial<RuleCondition>) => setConds(value.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const changeField = (i: number, field: RuleCondition["field"]) => {
    const kind = kindOf(field);
    const op: RuleCondition["op"] = kind === "bool" ? "is_true" : kind === "category" || kind === "priority" ? "equals" : "contains";
    const val = kind === "bool" ? undefined : kind === "category" ? "important" : kind === "priority" ? "high" : "";
    setConds(value.conditions.map((c, j) => (j === i ? { field, op, value: val } : c)));
  };
  const changeAction = (i: number, type: RuleAction["type"]) => setActions(value.actions.map((a, j) => (j === i ? { type, value: VALUE_ACTIONS.has(type) ? (a.value ?? "") : undefined } : a)));

  return (
    <div className="space-y-3 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">规则名</span>
        <Input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} className="h-8 max-w-56" />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>当以下条件</span>
          <select className={selectCls} value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as "all" | "any" })}>
            <option value="all">全部满足</option>
            <option value="any">任一满足</option>
          </select>
        </div>
        {value.conditions.map((c, i) => {
          const kind = kindOf(c.field);
          return (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <select className={selectCls} value={c.field} onChange={(e) => changeField(i, e.target.value as RuleCondition["field"])}>
                {FIELDS.map((f) => (
                  <option key={f.v} value={f.v}>
                    {f.label}
                  </option>
                ))}
              </select>
              <select className={selectCls} value={c.op} onChange={(e) => updateCond(i, { op: e.target.value as RuleCondition["op"] })}>
                {(kind === "bool" ? BOOL_OPS : TEXT_OPS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              {kind === "bool" ? null : kind === "category" ? (
                <select className={selectCls} value={c.value ?? ""} onChange={(e) => updateCond(i, { value: e.target.value })}>
                  {CATEGORIES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              ) : kind === "priority" ? (
                <select className={selectCls} value={c.value ?? ""} onChange={(e) => updateCond(i, { value: e.target.value })}>
                  {PRIORITIES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              ) : (
                <Input value={c.value ?? ""} onChange={(e) => updateCond(i, { value: e.target.value })} placeholder="值，如 bank@example.com" className="h-8 w-48" />
              )}
              {value.conditions.length > 1 ? (
                <button type="button" onClick={() => setConds(value.conditions.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive" aria-label="删除条件">
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
          );
        })}
        <Button size="xs" variant="ghost" onClick={() => setConds([...value.conditions, { field: "from", op: "contains", value: "" }])}>
          <Plus className="size-3.5" /> 加条件
        </Button>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs text-muted-foreground">则执行</div>
        {value.actions.map((a, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <select className={selectCls} value={a.type} onChange={(e) => changeAction(i, e.target.value as RuleAction["type"])}>
              {ACTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {VALUE_ACTIONS.has(a.type) ? (
              <Input value={a.value ?? ""} onChange={(e) => setActions(value.actions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder={a.type === "move" ? "文件夹名，如 Finance" : "标签名"} className="h-8 w-48" />
            ) : null}
            {value.actions.length > 1 ? (
              <button type="button" onClick={() => setActions(value.actions.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive" aria-label="删除动作">
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        ))}
        <Button size="xs" variant="ghost" onClick={() => setActions([...value.actions, { type: "flag" }])}>
          <Plus className="size-3.5" /> 加动作
        </Button>
      </div>
    </div>
  );
}
