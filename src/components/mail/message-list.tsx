"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ListTree, Loader2, Paperclip, RefreshCw, Search, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import type { MessageListItem } from "@/lib/api-types";
import { addressDisplayName, colorFor, formatListDate, initialsOf } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { useT } from "@/lib/locale-context";
import { cn } from "cn";
import { ThreadList } from "./thread-list";

const CONVERSATION_VIEW_KEY = "mailbox:conversationView";

export interface ListFilters {
  q: string;
  unread: boolean;
  flagged: boolean;
  category?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  important: "重要",
  todo: "待办",
  notification: "通知",
  billing: "账单",
  newsletter: "订阅",
  promotion: "推广",
  social: "社交",
  personal: "私人",
  other: "其他",
};

const CATEGORY_LABELS_EN: Record<string, string> = {
  important: "Important",
  todo: "To-do",
  notification: "Notification",
  billing: "Billing",
  newsletter: "Newsletter",
  promotion: "Promotion",
  social: "Social",
  personal: "Personal",
  other: "Other",
};

export function categoryLabel(category: string | null | undefined, locale: "zh-CN" | "en" = "zh-CN"): string | null {
  if (!category) return null;
  const table = locale === "en" ? CATEGORY_LABELS_EN : CATEGORY_LABELS;
  return table[category] ?? category;
}

function useDebounced<T>(value: T, delay: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export function MessageList({
  accountId,
  folderId,
  folderName,
  selectedId,
  onSelect,
  onRefresh,
  refreshing,
  headerExtra,
  onServerSearch,
  onSemanticSearch,
}: {
  accountId: string;
  folderId: string;
  folderName: string;
  selectedId: string | null;
  onSelect: (item: MessageListItem) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  headerExtra?: React.ReactNode;
  onServerSearch?: (q: string) => Promise<void>;
  onSemanticSearch?: (q: string) => void;
}) {
  const t = useT();
  const isEn = t.nav.language === "中文";
  const [filters, setFilters] = useState<ListFilters>({ q: "", unread: false, flagged: false });
  const q = useDebounced(filters.q, 300);
  const [serverSearching, setServerSearching] = useState(false);
  const filterKey = { q, unread: filters.unread, flagged: filters.flagged, category: filters.category };

  // 会话视图（按主题汇总 + 回复树）开关，记在 localStorage
  const [conversationView, setConversationView] = useState(false);
  useEffect(() => {
    try {
      setConversationView(localStorage.getItem(CONVERSATION_VIEW_KEY) === "1");
    } catch {
      /* 忽略 */
    }
  }, []);
  const toggleConversation = () =>
    setConversationView((v) => {
      const next = !v;
      try {
        localStorage.setItem(CONVERSATION_VIEW_KEY, next ? "1" : "0");
      } catch {
        /* 忽略 */
      }
      return next;
    });

  const query = useInfiniteQuery({
    queryKey: ["messages", accountId, folderId, filterKey],
    queryFn: ({ pageParam }) => api.messages({ accountId, folderId, cursor: pageParam, ...filterKey }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !conversationView,
  });

  const threadsQuery = useQuery({
    queryKey: ["threads", accountId, folderId, filterKey],
    queryFn: () => api.threads({ accountId, folderId, ...filterKey }),
    enabled: conversationView,
  });

  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const parentRef = useRef<HTMLDivElement>(null);
  const rowCount = items.length + (query.hasNextPage ? 1 : 0);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 76,
    overscan: 8,
  });

  const virtualItems = virtualizer.getVirtualItems();
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= items.length - 1 && query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [virtualItems, items.length, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b p-2">
        <div className="flex items-center justify-between gap-2 px-1">
          <h2 className="truncate text-sm font-semibold">{folderName}</h2>
          <div className="flex items-center gap-1">
            {headerExtra}
            <Button
              variant={conversationView ? "default" : "ghost"}
              size="icon-sm"
              onClick={toggleConversation}
              title={t.list.conversationView}
              aria-label={t.list.conversationView}
              aria-pressed={conversationView}
            >
              <ListTree className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onRefresh} title={t.list.refresh} aria-label={t.list.refresh} disabled={refreshing}>
              <RefreshCw className={cn("size-4", (refreshing || query.isFetching || threadsQuery.isFetching) && "animate-spin")} />
            </Button>
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} placeholder={t.list.searchPlaceholder} className="pl-8" />
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="xs" variant={filters.unread ? "default" : "outline"} onClick={() => setFilters((f) => ({ ...f, unread: !f.unread }))}>
            {t.list.unread}
          </Button>
          <Button size="xs" variant={filters.flagged ? "default" : "outline"} onClick={() => setFilters((f) => ({ ...f, flagged: !f.flagged }))}>
            {t.list.flagged}
          </Button>
          <select
            aria-label={t.list.categoryFilter}
            className="h-6 rounded-md border border-input bg-background px-1.5 text-xs"
            value={filters.category ?? ""}
            onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value || undefined }))}
          >
            <option value="">{t.list.allCategories}</option>
            {Object.keys(CATEGORY_LABELS).map((k) => (
              <option key={k} value={k}>
                {categoryLabel(k, isEn ? "en" : "zh-CN")}
              </option>
            ))}
          </select>
          {q && onServerSearch ? (
            <Button
              size="xs"
              variant="outline"
              disabled={serverSearching}
              onClick={async () => {
                setServerSearching(true);
                try {
                  await onServerSearch(q);
                } finally {
                  setServerSearching(false);
                }
              }}
            >
              {serverSearching ? <Loader2 className="size-3 animate-spin" /> : null} {t.list.serverSearch}
            </Button>
          ) : null}
          {q && onSemanticSearch ? (
            <Button size="xs" variant="outline" onClick={() => onSemanticSearch(q)}>
              {t.list.semanticSearch}
            </Button>
          ) : null}
        </div>
      </div>

      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        {conversationView ? (
          threadsQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {t.list.loading}
            </div>
          ) : threadsQuery.isError ? (
            <div className="p-6 text-sm text-destructive">{fmt(t.list.loadFailed, { error: (threadsQuery.error as Error).message })}</div>
          ) : !threadsQuery.data || threadsQuery.data.threads.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">{q || filters.unread || filters.flagged ? t.list.noMatch : t.list.empty}</div>
          ) : (
            <ThreadList threads={threadsQuery.data.threads} capped={threadsQuery.data.capped} selectedId={selectedId} onSelect={onSelect} isEn={isEn} />
          )
        ) : query.isLoading ? (
          <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t.list.loading}
          </div>
        ) : query.isError ? (
          <div className="p-6 text-sm text-destructive">{fmt(t.list.loadFailed, { error: (query.error as Error).message })}</div>
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">{q || filters.unread || filters.flagged ? t.list.noMatch : t.list.empty}</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((row) => {
              const item = items[row.index];
              if (!item) {
                return (
                  <div
                    key="loader"
                    className="flex items-center justify-center py-3 text-xs text-muted-foreground"
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)` }}
                  >
                    <Loader2 className="mr-2 size-3 animate-spin" /> {t.list.loadMore}
                  </div>
                );
              }
              const from = item.from[0];
              const label = categoryLabel(item.ai?.category, isEn ? "en" : "zh-CN");
              return (
                <button
                  type="button"
                  key={item.id}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  onClick={() => onSelect(item)}
                  className={cn("flex w-full items-start gap-3 border-b px-3 py-2.5 text-left hover:bg-muted/60", selectedId === item.id && "bg-muted")}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)` }}
                >
                  <div
                    className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
                    style={{ background: colorFor(from?.address ?? "?") }}
                  >
                    {initialsOf(from)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn("min-w-0 flex-1 truncate text-sm", !item.seen && "font-semibold")}>{addressDisplayName(from) || t.list.unknownSender}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{formatListDate(item.date)}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {!item.seen ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
                      <span className={cn("min-w-0 flex-1 truncate text-sm", !item.seen ? "font-medium" : "text-foreground/90")}>{item.subject || t.list.noSubject}</span>
                      {item.flagged ? <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" /> : null}
                      {item.hasAttachments ? <Paperclip className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {label ? (
                        <span className={cn("shrink-0 rounded px-1 text-[10px] leading-4", item.ai?.priority === "high" ? "bg-red-100 text-red-700" : "bg-muted text-muted-foreground")}>{label}</span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.ai?.summary || item.snippet || (item.bodyFetched ? "" : t.list.bodyLoading)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
