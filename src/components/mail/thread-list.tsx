"use client";

import { ChevronDown, ChevronRight, Paperclip, Star } from "lucide-react";
import { useMemo, useState } from "react";
import type { MessageListItem, ThreadGroup, ThreadNode } from "@/lib/api-types";
import { addressDisplayName, colorFor, formatListDate, initialsOf } from "@/lib/format";
import { useT } from "@/lib/locale-context";
import { categoryLabel } from "./message-list";
import { cn } from "cn";

/** 会话视图：按主题汇总的会话列表，每个会话内按回复关系展示树。 */
export function ThreadList({
  threads,
  capped,
  selectedId,
  onSelect,
  isEn,
}: {
  threads: ThreadGroup[];
  capped: boolean;
  selectedId: string | null;
  onSelect: (item: MessageListItem) => void;
  isEn: boolean;
}) {
  const t = useT();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  // 每个会话包含的邮件 id 集合（用于判断是否含选中项）
  const idsByKey = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const collect = (nodes: ThreadNode[], set: Set<string>) => {
      for (const n of nodes) {
        set.add(n.message.id);
        collect(n.children, set);
      }
    };
    for (const g of threads) {
      const set = new Set<string>();
      collect(g.roots, set);
      map.set(g.key, set);
    }
    return map;
  }, [threads]);

  const isOpen = (g: ThreadGroup) => {
    if (g.key in overrides) return overrides[g.key];
    return g.unreadCount > 0 || Boolean(selectedId && idsByKey.get(g.key)?.has(selectedId));
  };
  const toggle = (key: string, open: boolean) => setOverrides((o) => ({ ...o, [key]: open }));

  const row = (item: MessageListItem, depth: number, showSubject: boolean) => {
    const from = item.from[0];
    const label = categoryLabel(item.ai?.category, isEn ? "en" : "zh-CN");
    return (
      <button
        type="button"
        key={item.id}
        onClick={() => onSelect(item)}
        className={cn("flex w-full items-start gap-2.5 border-b px-3 py-2 text-left hover:bg-muted/60", selectedId === item.id && "bg-muted")}
        style={{ paddingLeft: `${12 + depth * 18}px` }}
      >
        {depth > 0 ? <span className="mt-2 shrink-0 text-muted-foreground/50">↳</span> : null}
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: colorFor(from?.address ?? "?") }}>
          {initialsOf(from)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {!item.seen ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
            <span className={cn("min-w-0 flex-1 truncate text-sm", !item.seen && "font-semibold")}>{addressDisplayName(from) || t.list.unknownSender}</span>
            {item.flagged ? <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" /> : null}
            {item.hasAttachments ? <Paperclip className="size-3.5 shrink-0 text-muted-foreground" /> : null}
            <span className="shrink-0 text-[11px] text-muted-foreground">{formatListDate(item.date)}</span>
          </div>
          {showSubject ? <div className={cn("truncate text-sm", !item.seen ? "font-medium" : "text-foreground/90")}>{item.subject || t.list.noSubject}</div> : null}
          <div className="flex items-center gap-1.5">
            {label ? (
              <span className={cn("shrink-0 rounded px-1 text-[10px] leading-4", item.ai?.priority === "high" ? "bg-red-100 text-red-700" : "bg-muted text-muted-foreground")}>{label}</span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.ai?.summary || item.snippet || (item.bodyFetched ? "" : t.list.bodyLoading)}</span>
          </div>
        </div>
      </button>
    );
  };

  const renderNode = (node: ThreadNode, depth: number): React.ReactNode => (
    <div key={node.message.id}>
      {row(node.message, depth, false)}
      {node.children.map((c) => renderNode(c, depth + 1))}
    </div>
  );

  return (
    <div>
      {capped ? <div className="border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">{t.list.threadCapped}</div> : null}
      {threads.map((g) => {
        // 单封邮件：直接当普通一行（带主题），不显示会话头
        if (g.messageCount <= 1 && g.roots.length === 1 && g.roots[0].children.length === 0) {
          return <div key={g.key}>{row(g.roots[0].message, 0, true)}</div>;
        }
        const open = isOpen(g);
        const parts = g.participants.slice(0, 3).join("、") + (g.participants.length > 3 ? ` +${g.participants.length - 3}` : "");
        return (
          <div key={g.key}>
            <button
              type="button"
              onClick={() => toggle(g.key, !open)}
              className="flex w-full items-start gap-2 border-b bg-muted/20 px-3 py-2 text-left hover:bg-muted/50"
            >
              {open ? <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {g.unreadCount > 0 ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
                  <span className={cn("min-w-0 flex-1 truncate text-sm", g.unreadCount > 0 && "font-semibold")}>{g.subject || t.list.noSubject}</span>
                  {g.flagged ? <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" /> : null}
                  {g.hasAttachments ? <Paperclip className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                  <span className="shrink-0 text-[11px] text-muted-foreground">{formatListDate(g.lastDate)}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="shrink-0 rounded-full bg-muted px-1.5 leading-4">{g.messageCount}</span>
                  <span className="min-w-0 flex-1 truncate">{parts}</span>
                </div>
              </div>
            </button>
            {open ? g.roots.map((n) => renderNode(n, 0)) : null}
          </div>
        );
      })}
    </div>
  );
}
