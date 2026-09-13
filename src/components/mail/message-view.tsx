"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, ImageOff, Loader2, MailX, Paperclip } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { unsubscribeAction } from "@/app/mail/actions";
import { EmailFrame } from "@/components/mail/email-frame";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import type { MessageDetail } from "@/lib/api-types";
import { addressDisplayName, colorFor, formatAddressList, formatBytes, formatFullDate, initialsOf } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { useLocale, useT } from "@/lib/locale-context";
import { categoryLabel } from "./message-list";

export function MessageView({
  messageId,
  toolbar,
  onLoaded,
}: {
  messageId: string;
  /** 由上层注入的操作按钮 */
  toolbar?: (message: MessageDetail) => React.ReactNode;
  onLoaded?: (message: MessageDetail) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [remote, setRemote] = useState(false);
  const [unsubPending, startUnsub] = useTransition();
  const unsubscribe = () =>
    startUnsub(async () => {
      const r = await unsubscribeAction(messageId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.data.method === "link") {
        window.open(r.data.url, "_blank", "noopener");
        toast.info(t.view.unsubOpened);
      } else if (r.data.method === "mailto") toast.success(fmt(t.view.unsubMailto, { to: r.data.detail }));
      else if (r.data.method === "one-click") toast.success(fmt(t.view.unsubOneClick, { to: r.data.detail }));
      else toast.info(t.view.unsubNone);
    });
  const query = useQuery({
    queryKey: ["message", messageId, remote],
    queryFn: async () => {
      const m = await api.message(messageId, { remote });
      onLoaded?.(m);
      return m;
    },
  });

  if (query.isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> {t.view.loading}
      </div>
    );
  }
  if (query.isError || !query.data) {
    return <div className="p-6 text-sm text-destructive">{fmt(t.view.loadFailed, { error: (query.error as Error)?.message ?? "" })}</div>;
  }
  const m = query.data;
  const from = m.from[0];
  const label = categoryLabel(m.ai?.category, locale);

  return (
    <div className="flex h-full flex-col">
      {toolbar ? <div className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5">{toolbar(m)}</div> : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="space-y-3 border-b px-4 py-3">
          <h1 className="text-lg font-semibold leading-snug">{m.subject || t.list.noSubject}</h1>
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ background: colorFor(from?.address ?? "?") }}>
              {initialsOf(from)}
            </div>
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{addressDisplayName(from) || t.list.unknownSender}</span>
                {from?.address ? <span className="text-muted-foreground">&lt;{from.address}&gt;</span> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {t.view.to}：{formatAddressList(m.to) || "—"}
              </div>
              {m.cc.length ? (
                <div className="text-xs text-muted-foreground">
                  {t.view.cc}：{formatAddressList(m.cc)}
                </div>
              ) : null}
              <div className="text-xs text-muted-foreground">{formatFullDate(m.date)}</div>
            </div>
            {m.listUnsubscribe ? (
              <Button size="xs" variant="outline" onClick={unsubscribe} disabled={unsubPending} title={m.listUnsubscribe}>
                {unsubPending ? <Loader2 className="size-3 animate-spin" /> : <MailX className="size-3" />} {t.view.unsubscribe}
              </Button>
            ) : null}
          </div>
          {m.ai?.summary ? (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                {t.view.aiSummary}
                {label ? <span className="rounded bg-background px-1.5 py-0.5">{label}</span> : null}
                {m.ai.priority === "high" ? <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700">{t.view.highPriority}</span> : null}
              </div>
              <div>{m.ai.summary}</div>
              {m.ai.actionItems?.length ? (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs">
                  {m.ai.actionItems.map((a, i) => (
                    <li key={i}>
                      {a.title}
                      {a.dueAt ? <span className="text-muted-foreground">（{a.dueAt}）</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {m.blockedRemoteImages > 0 && !remote ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <span className="flex items-center gap-1.5">
                <ImageOff className="size-3.5" /> {fmt(t.view.blockedImages, { n: m.blockedRemoteImages })}
              </span>
              <Button size="xs" variant="outline" onClick={() => setRemote(true)}>
                {t.view.showImages}
              </Button>
            </div>
          ) : null}
        </div>

        {m.html ? (
          <EmailFrame html={m.html} />
        ) : m.bodyFetched ? (
          <div className="p-6 text-sm text-muted-foreground">{t.view.noBody}</div>
        ) : (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t.view.fetchingBody}
          </div>
        )}

        {m.attachments.length ? (
          <div className="border-t px-4 py-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Paperclip className="size-3.5" /> {t.view.attachments}（{m.attachments.length}）
            </div>
            <ul className="flex flex-wrap gap-2">
              {m.attachments.map((a) => (
                <li key={a.id}>
                  <a href={`/api/mail/attachments/${a.id}`} className="inline-flex max-w-xs items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted" download={a.filename ?? undefined}>
                    <Download className="size-3.5 shrink-0" />
                    <span className="truncate">{a.filename || t.view.unnamedAttachment}</span>
                    <span className="shrink-0 text-muted-foreground">{formatBytes(a.size)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
