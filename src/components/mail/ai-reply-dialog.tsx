"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { aiDraftReplyAction } from "@/app/mail/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/** AI 起草回复：可选补充要求 → 生成 → 交给写信框继续编辑。 */
export function AiReplyDialog({
  open,
  onOpenChange,
  messageId,
  onDraft,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: string;
  onDraft: (text: string) => void;
}) {
  const [instructions, setInstructions] = useState("");
  const [pending, start] = useTransition();

  const generate = () =>
    start(async () => {
      const r = await aiDraftReplyAction(messageId, instructions);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`已用 ${r.data.model} 生成草稿，可继续编辑`);
      onDraft(r.data.text);
      onOpenChange(false);
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>AI 起草回复</DialogTitle>
          <DialogDescription>可以告诉 AI 你的想法，例如「同意，下周三下午可以」「婉拒，说明预算有限」。留空则按常规礼貌回复。</DialogDescription>
        </DialogHeader>
        <Textarea aria-label="补充要求" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="补充要求（可选）" className="min-h-24" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button onClick={generate} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} 生成草稿
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
