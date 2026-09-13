"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2, Paperclip, RefreshCw, Search, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import type { MessageListItem } from "@/lib/api-types";
import { addressDisplayName, colorFor, formatListDate, initialsOf } from "@/lib/format";
import { cn } from "cn";

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

export function categoryLabel(category: string | null | undefined): string | null {
  if (!category) return null;
  return CATEGORY_LABELS[category] ?? category;
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
}) {
  const [filters, setFilters] = useState<ListFilters>({ q: "", unread: false, flagged: false });
  const q = useDebounced(filters.q, 300);
  const [serverSearching, setServerSearching] = useState(false);
  const filterKey = { q, unread: filters.unread, flagged: filters.flagged, category: filters.category };

  const query = useInfiniteQuery({
    queryKey: ["messages", accountId, folderId, filterKey],
    queryFn: ({ pageParam }) => api.messages({ accountId, folderId, cursor: pageParam, ...filterKey }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
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
            <Button variant="ghost" size="icon-sm" onClick={onRefresh} title="刷新" disabled={refreshing}>
              <RefreshCw className={cn("size-4", (refreshing || query.isFetching) && "animate-spin")} />
            </Button>
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            placeholder="搜索主题、发件人、内容…"
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            size="xs"
            variant={filters.unread ? "default" : "outline"}
            onClick={() => setFilters((f) => ({ ...f, unread: !f.unread }))}
          >
            未读
          </Button>
          <Button
            size="xs"
            variant={filters.flagged ? "default" : "outline"}
            onClick={() => setFilters((f) => ({ ...f, flagged: !f.flagged }))}
          >
            星标
          </Button>
          {filters.category ? (
            <Button size="xs" variant="default" onClick={() => setFilters((f) => ({ ...f, category: undefined }))}>
              {categoryLabel(filters.category)} ×
            </Button>
          ) : null}
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
              {serverSearching ? <Loader2 className="size-3 animate-spin" /> : null} 在服务器上搜索
            </Button>
          ) : null}
        </div>
      </div>

      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        {query.isLoading ? (
          <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 加载中…
          </div>
        ) : query.isError ? (
          <div className="p-6 text-sm text-destructive">加载失败：{(query.error as Error).message}</div>
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {q || filters.unread || filters.flagged ? "没有匹配的邮件" : "这个文件夹还没有邮件（初次同步可能需要几分钟）"}
          </div>
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
                    <Loader2 className="mr-2 size-3 animate-spin" /> 加载更多…
                  </div>
                );
              }
              const from = item.from[0];
              const label = categoryLabel(item.ai?.category);
              return (
                <button
                  type="button"
                  key={item.id}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  onClick={() => onSelect(item)}
                  className={cn(
                    "flex w-full items-start gap-3 border-b px-3 py-2.5 text-left hover:bg-muted/60",
                    selectedId === item.id && "bg-muted",
                  )}
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
                      <span className={cn("min-w-0 flex-1 truncate text-sm", !item.seen && "font-semibold")}>
                        {addressDisplayName(from) || "(未知发件人)"}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{formatListDate(item.date)}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {!item.seen ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
                      <span className={cn("min-w-0 flex-1 truncate text-sm", !item.seen ? "font-medium" : "text-foreground/90")}>
                        {item.subject || "(无主题)"}
                      </span>
                      {item.flagged ? <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" /> : null}
                      {item.hasAttachments ? <Paperclip className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {label ? (
                        <span
                          className={cn(
                            "shrink-0 rounded px-1 text-[10px] leading-4",
                            item.ai?.priority === "high" ? "bg-red-100 text-red-700" : "bg-muted text-muted-foreground",
                          )}
                        >
                          {label}
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {item.ai?.summary || item.snippet || (item.bodyFetched ? "" : "正文加载中…")}
                      </span>
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
