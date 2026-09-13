"use client";

import { Loader2, Paperclip, Send, X } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { saveDraftAction, sendMailAction } from "@/app/mail/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ComposePayload, UploadedAttachment } from "@/lib/api-types";
import { formatBytes } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { useT } from "@/lib/locale-context";

export interface ComposeInitial {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text?: string;
  inReplyToMessageId?: string;
  forwardOfMessageId?: string;
  includeOriginalAttachments?: boolean;
  draftMessageId?: string;
  /** 转发时展示的原附件名（仅提示，内容由服务端从原邮件取） */
  originalAttachmentNames?: string[];
}

/**
 * 写信对话框：发送走 SMTP；草稿 APPEND 到服务器草稿箱。
 * 用 key 重新挂载来重置内容（父组件每次打开时换 key）。
 */
export function ComposeDialog({
  open,
  onOpenChange,
  accountId,
  accountEmail,
  initial,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountEmail: string;
  initial?: ComposeInitial;
  onSent?: () => void;
}) {
  const t = useT().compose;
  const [to, setTo] = useState(initial?.to ?? "");
  const [cc, setCc] = useState(initial?.cc ?? "");
  const [bcc, setBcc] = useState(initial?.bcc ?? "");
  const [showCc, setShowCc] = useState(Boolean(initial?.cc || initial?.bcc));
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [includeOriginal, setIncludeOriginal] = useState(initial?.includeOriginalAttachments ?? false);
  const [uploading, setUploading] = useState(false);
  const [sending, startSend] = useTransition();
  const [saving, startSave] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);

  const payload = (): ComposePayload => ({
    to,
    cc,
    bcc,
    subject,
    text,
    attachments,
    inReplyToMessageId: initial?.inReplyToMessageId,
    forwardOfMessageId: initial?.forwardOfMessageId,
    includeOriginalAttachments: includeOriginal,
    draftMessageId: initial?.draftMessageId,
  });

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/mail/uploads", { method: "POST", body: form });
        const body = (await res.json()) as UploadedAttachment & { error?: string };
        if (!res.ok) throw new Error(body.error ?? fmt(t.uploadFailed, { status: res.status }));
        setAttachments((list) => [...list, body]);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const send = () =>
    startSend(async () => {
      const r = await sendMailAction(accountId, payload());
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t.sending);
      onSent?.();
      onOpenChange(false);
    });

  const save = () =>
    startSave(async () => {
      const r = await saveDraftAction(accountId, payload());
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t.draftSaved);
      onOpenChange(false);
    });

  const busy = sending || saving || uploading;
  const title = initial?.draftMessageId ? t.titleDraft : initial?.inReplyToMessageId ? t.titleReply : initial?.forwardOfMessageId ? t.titleForward : t.titleNew;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-3 max-sm:h-full max-sm:max-h-full max-sm:max-w-full max-sm:rounded-none sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{fmt(t.from, { email: accountEmail })}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="w-12 shrink-0 text-sm text-muted-foreground" htmlFor="compose-to">
              {t.to}
            </label>
            <Input id="compose-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t.toPlaceholder} />
            {!showCc ? (
              <Button variant="ghost" size="xs" onClick={() => setShowCc(true)}>
                {t.ccBcc}
              </Button>
            ) : null}
          </div>
          {showCc ? (
            <>
              <div className="flex items-center gap-2">
                <label className="w-12 shrink-0 text-sm text-muted-foreground" htmlFor="compose-cc">
                  {t.cc}
                </label>
                <Input id="compose-cc" value={cc} onChange={(e) => setCc(e.target.value)} />
              </div>
              <div className="flex items-center gap-2">
                <label className="w-12 shrink-0 text-sm text-muted-foreground" htmlFor="compose-bcc">
                  {t.bcc}
                </label>
                <Input id="compose-bcc" value={bcc} onChange={(e) => setBcc(e.target.value)} />
              </div>
            </>
          ) : null}
          <div className="flex items-center gap-2">
            <label className="w-12 shrink-0 text-sm text-muted-foreground" htmlFor="compose-subject">
              {t.subject}
            </label>
            <Input id="compose-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
        </div>

        <Textarea aria-label={t.body} value={text} onChange={(e) => setText(e.target.value)} className="min-h-[240px] flex-1 resize-y font-sans text-sm" placeholder={t.bodyPlaceholder} />

        {initial?.originalAttachmentNames?.length ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={includeOriginal} onChange={(e) => setIncludeOriginal(e.target.checked)} />
            {fmt(t.includeOriginal, { names: initial.originalAttachmentNames.join("、") })}
          </label>
        ) : null}

        {attachments.length ? (
          <ul className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
                <Paperclip className="size-3" />
                <span className="max-w-48 truncate">{a.filename}</span>
                <span className="text-muted-foreground">{formatBytes(a.size)}</span>
                <button type="button" onClick={() => setAttachments((l) => l.filter((x) => x.id !== a.id))} aria-label={t.removeAttachment}>
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <div className="flex items-center gap-2">
            <Button onClick={send} disabled={busy || !to.trim()}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t.send}
            </Button>
            <Button variant="outline" onClick={save} disabled={busy}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null} {t.saveDraft}
            </Button>
            <Button variant="ghost" onClick={() => fileInput.current?.click()} disabled={busy}>
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />} {t.attach}
            </Button>
            <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
          </div>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t.discard}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
