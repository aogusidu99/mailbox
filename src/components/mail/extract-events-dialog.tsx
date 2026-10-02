"use client";

import { CalendarPlus, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { addEventsAction, proposeEventsFromMessagesAction } from "@/app/mail/calendar/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { EventCandidate } from "@/server/google/extract-events";

/** 从单封邮件抽取日程（用完整正文，更准）→ 勾选后加入 Google 日历 */
export function ExtractEventsDialog({ open, onOpenChange, messageId }: { open: boolean; onOpenChange: (o: boolean) => void; messageId: string }) {
  const [candidates, setCandidates] = useState<EventCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [pending, start] = useTransition();
  const fetchedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      fetchedRef.current = null;
      return;
    }
    if (fetchedRef.current === messageId) return;
    fetchedRef.current = messageId;
    start(async () => {
      setCandidates(null);
      setPicked(new Set());
      const r = await proposeEventsFromMessagesAction([messageId]);
      if (!r.ok) {
        toast.error(r.error);
        onOpenChange(false);
        return;
      }
      setCandidates(r.data.candidates);
      setPicked(new Set(r.data.candidates.map((_, i) => i)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, messageId]);

  const toggle = (i: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  const add = () =>
    start(async () => {
      if (!candidates) return;
      const chosen = candidates.filter((_, i) => picked.has(i));
      if (chosen.length === 0) return void toast.error("请先勾选要加入的日程");
      const r = await addEventsAction(chosen.map(({ title, start: s, end, allDay, location, description }) => ({ title, start: s, end, allDay, location, description })));
      if (!r.ok) return void toast.error(r.error);
      toast.success(`已加入 ${r.data.created.length} 个日程${r.data.failed ? `，失败 ${r.data.failed}` : ""}`);
      onOpenChange(false);
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>从这封邮件提取日程</DialogTitle>
          <DialogDescription>AI 会分析这封邮件的完整正文，找出带时间的会议 / 预约，供你确认加入 Google 日历。</DialogDescription>
        </DialogHeader>

        {pending && candidates === null ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 正在分析邮件…
          </div>
        ) : candidates && candidates.length > 0 ? (
          <>
            <div className="max-h-80 divide-y overflow-auto rounded-md border">
              {candidates.map((c, i) => (
                <label key={i} className="flex cursor-pointer items-start gap-2 px-3 py-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={picked.has(i)} onChange={() => toggle(i)} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{c.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.allDay ? `${c.start.slice(0, 10)} 全天` : new Date(c.start).toLocaleString()}
                      {c.location ? ` · ${c.location}` : ""}
                    </div>
                  </div>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
                取消
              </Button>
              <Button onClick={add} disabled={pending || picked.size === 0}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <CalendarPlus className="size-4" />} 加入日历（{picked.size}）
              </Button>
            </div>
          </>
        ) : (
          <div className="py-6 text-sm text-muted-foreground">这封邮件里没有找到带时间的日程。</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
