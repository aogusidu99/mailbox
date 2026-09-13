"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { semanticSearchAction } from "@/app/mail/actions";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatListDate } from "@/lib/format";
import type { SemanticHit } from "@/server/ai/embeddings";

/** 语义搜索结果对话框：打开即执行一次搜索。 */
export function SemanticSearchDialog({ open, onOpenChange, query, accountId }: { open: boolean; onOpenChange: (o: boolean) => void; query: string; accountId: string }) {
  const [state, setState] = useState<{ loading: boolean; hits: SemanticHit[]; error?: string }>({ loading: true, hits: [] });

  useEffect(() => {
    let cancelled = false;
    semanticSearchAction(query, accountId).then((r) => {
      if (cancelled) return;
      if (!r.ok) setState({ loading: false, hits: [], error: r.error });
      else setState({ loading: false, hits: r.data });
    });
    return () => {
      cancelled = true;
    };
  }, [query, accountId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>语义搜索：{query}</DialogTitle>
          <DialogDescription>按含义匹配，而不是关键词。只包含已向量化的邮件。</DialogDescription>
        </DialogHeader>
        {state.loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 搜索中…
          </div>
        ) : state.error ? (
          <p className="text-sm text-destructive">{state.error}</p>
        ) : state.hits.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有相似的邮件。</p>
        ) : (
          <ul className="max-h-96 divide-y overflow-auto text-sm">
            {state.hits.map((h) => (
              <li key={h.messageId} className="py-2">
                <Link href={`/mail/${h.accountId}/${h.folderId}?m=${h.messageId}`} onClick={() => onOpenChange(false)} className="block hover:underline">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{h.subject ?? "(无主题)"}</span>
                    <span className="text-xs text-muted-foreground">
                      {h.from} · {h.folderName} · {formatListDate(h.date)} · 相似度 {h.score}
                    </span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{h.snippet}</div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
