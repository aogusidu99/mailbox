"use client";

import { CalendarDays, CalendarPlus, Check, ChevronLeft, ChevronRight, ExternalLink, List, Loader2, Pencil, Plus, RefreshCw, Sparkles, Trash2, Unlink, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CalEvent, CalEventInput } from "@/server/google/calendar";
import type { EventCandidate } from "@/server/google/extract-events";
import { cn } from "cn";
import { addEventsAction, createEventAction, deleteEventAction, disconnectGoogleAction, proposeEventsAction, refreshEventsAction, updateEventAction } from "./actions";

interface Draft {
  id: string | null;
  /** 事件所属日历；新建默认主日历 primary */
  calendarId: string;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  location: string;
  description: string;
}

// ---------- 日期辅助 ----------

const MONTH_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function localKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
/** ISO → datetime-local 输入值（本地时区，YYYY-MM-DDTHH:mm） */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function eventDayKey(e: CalEvent): string {
  const d = new Date(e.start);
  return Number.isNaN(d.getTime()) ? e.start.slice(0, 10) : localKey(d);
}
function timeLabel(e: CalEvent): string {
  if (e.allDay) return "全天";
  const d = new Date(e.start);
  if (Number.isNaN(d.getTime())) return "";
  const t = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (e.end) {
    const de = new Date(e.end);
    if (!Number.isNaN(de.getTime())) return `${t}–${pad2(de.getHours())}:${pad2(de.getMinutes())}`;
  }
  return t;
}
function hhmm(e: CalEvent): string {
  if (e.allDay) return "";
  const d = new Date(e.start);
  return Number.isNaN(d.getTime()) ? "" : `${pad2(d.getHours())}:${pad2(d.getMinutes())} `;
}

function monthGrid(cursor: Date): Date[] {
  const first = firstOfMonth(cursor);
  const dow = (first.getDay() + 6) % 7; // 周一=0
  const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - dow);
  return Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
}
function monthRangeIso(cursor: Date): { from: string; to: string } {
  const days = monthGrid(cursor);
  return { from: days[0].toISOString(), to: new Date(days[41].getFullYear(), days[41].getMonth(), days[41].getDate() + 1).toISOString() };
}
/** 日程视图宽时间窗：过去 90 ~ 未来 366 天 */
function agendaRangeIso(): { from: string; to: string } {
  const now = Date.now();
  return { from: new Date(now - 90 * 86_400_000).toISOString(), to: new Date(now + 366 * 86_400_000).toISOString() };
}
function dayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00`);
  const isToday = d.toDateString() === new Date().toDateString();
  return `${key.slice(5)} ${MONTH_WEEKDAYS[(d.getDay() + 6) % 7]}${isToday ? "（今天）" : ""}`;
}

function emptyDraft(): Draft {
  const now = toLocalInput(new Date(Date.now() + 3_600_000).toISOString());
  return { id: null, calendarId: "primary", title: "", allDay: false, start: now, end: "", location: "", description: "" };
}
function draftOnDay(key: string): Draft {
  return { id: null, calendarId: "primary", title: "", allDay: false, start: `${key}T09:00`, end: "", location: "", description: "" };
}
function draftFromEvent(e: CalEvent): Draft {
  return {
    id: e.id,
    calendarId: e.calendarId,
    title: e.title,
    allDay: e.allDay,
    start: e.allDay ? e.start.slice(0, 10) : toLocalInput(e.start),
    end: e.end ? (e.allDay ? e.end.slice(0, 10) : toLocalInput(e.end)) : "",
    location: e.location ?? "",
    description: e.description ?? "",
  };
}
function draftToInput(d: Draft): CalEventInput {
  if (d.allDay) {
    return { title: d.title.trim(), allDay: true, start: d.start, end: d.end || null, location: d.location || null, description: d.description || null };
  }
  return {
    title: d.title.trim(),
    allDay: false,
    start: new Date(d.start).toISOString(),
    end: d.end ? new Date(d.end).toISOString() : null,
    location: d.location || null,
    description: d.description || null,
  };
}

export function CalendarView({ initialEvents, email, initialError }: { initialEvents: CalEvent[]; email: string | null; initialError: string | null }) {
  const router = useRouter();
  const [events, setEvents] = useState<CalEvent[]>(initialEvents);
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error] = useState<string | null>(initialError);

  const [viewMode, setViewMode] = useState<"month" | "agenda">("month");
  const [monthCursor, setMonthCursor] = useState<Date>(() => firstOfMonth(new Date()));

  // AI 提取
  const [days, setDays] = useState(14);
  const [candidates, setCandidates] = useState<EventCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [aiPending, startAi] = useTransition();

  const refreshCurrent = async () => {
    const range = viewMode === "month" ? monthRangeIso(monthCursor) : agendaRangeIso();
    const r = await refreshEventsAction(range);
    if (r.ok) setEvents(r.data.events);
    return r;
  };

  useEffect(() => {
    const range = viewMode === "month" ? monthRangeIso(monthCursor) : agendaRangeIso();
    start(async () => {
      const r = await refreshEventsAction(range);
      if (r.ok) setEvents(r.data.events);
      else toast.error(r.error);
    });
  }, [viewMode, monthCursor]);

  const reload = () =>
    start(async () => {
      const r = await refreshCurrent();
      if (!r.ok) toast.error(r.error);
    });

  const saveDraft = () =>
    start(async () => {
      if (!draft) return;
      if (!draft.title.trim()) return void toast.error("请填写标题");
      if (!draft.start) return void toast.error("请填写开始时间");
      const input = draftToInput(draft);
      const r = draft.id ? await updateEventAction(draft.calendarId, draft.id, input) : await createEventAction(input);
      if (!r.ok) return void toast.error(r.error);
      toast.success(draft.id ? "已更新日程" : "已新建日程");
      setDraft(null);
      await refreshCurrent();
    });

  const remove = (e: CalEvent) =>
    start(async () => {
      if (!confirm(`删除日程「${e.title}」？`)) return;
      const r = await deleteEventAction(e.calendarId, e.id);
      if (!r.ok) return void toast.error(r.error);
      setEvents((list) => list.filter((x) => x.id !== e.id));
      toast.success("已删除");
    });

  const disconnect = () =>
    start(async () => {
      if (!confirm("断开 Google 连接？（不会删除 Google 上的数据）")) return;
      const r = await disconnectGoogleAction();
      if (!r.ok) return void toast.error(r.error);
      router.refresh();
    });

  const propose = () =>
    startAi(async () => {
      const r = await proposeEventsAction(days);
      if (!r.ok) return void toast.error(r.error);
      setCandidates(r.data.candidates);
      setPicked(new Set(r.data.candidates.map((_, i) => i)));
      toast.success(r.data.candidates.length ? `AI 找到 ${r.data.candidates.length} 个候选日程` : "近期邮件里没有找到明确的日程");
    });

  const addPicked = () =>
    startAi(async () => {
      if (!candidates) return;
      const chosen = candidates.filter((_, i) => picked.has(i));
      if (chosen.length === 0) return void toast.error("请先勾选要加入的日程");
      const r = await addEventsAction(chosen.map(({ title, start: s, end, allDay, location, description }) => ({ title, start: s, end, allDay, location, description })));
      if (!r.ok) return void toast.error(r.error);
      toast.success(`已加入 ${r.data.created.length} 个日程${r.data.failed ? `，失败 ${r.data.failed}` : ""}`);
      setCandidates(null);
      setPicked(new Set());
      await refreshCurrent();
    });

  const byDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of events) {
      const k = eventDayKey(e);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(e);
    }
    return map;
  }, [events]);
  const gridDays = useMemo(() => monthGrid(monthCursor), [monthCursor]);
  const agendaDays = useMemo(() => [...byDay.keys()].sort(), [byDay]);
  const todayKey = localKey(new Date());
  const curMonth = monthCursor.getMonth();

  const openEvent = (e: CalEvent) => (e.readOnly ? e.htmlLink && window.open(e.htmlLink, "_blank") : setDraft(draftFromEvent(e)));

  return (
    <div className="space-y-4">
      {/* 顶部 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          已连接 <span className="font-medium text-foreground">{email ?? "Google"}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={reload} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} 刷新
          </Button>
          <Button size="sm" onClick={() => setDraft(emptyDraft())} disabled={pending}>
            <CalendarPlus className="size-4" /> 新建日程
          </Button>
          <Button size="sm" variant="ghost" onClick={disconnect} disabled={pending}>
            <Unlink className="size-4" /> 断开
          </Button>
        </div>
      </div>

      {/* 视图切换 + 月份导航 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex overflow-hidden rounded-md border">
          <button type="button" onClick={() => setViewMode("month")} className={cn("inline-flex items-center gap-1 px-3 py-1.5 text-sm", viewMode === "month" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
            <CalendarDays className="size-4" /> 月
          </button>
          <button type="button" onClick={() => setViewMode("agenda")} className={cn("inline-flex items-center gap-1 px-3 py-1.5 text-sm", viewMode === "agenda" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
            <List className="size-4" /> 日程
          </button>
        </div>
        {viewMode === "month" ? (
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setMonthCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))} className="inline-flex size-8 items-center justify-center rounded-md border hover:bg-muted" aria-label="上个月">
              <ChevronLeft className="size-4" />
            </button>
            <span className="min-w-28 text-center text-sm font-medium">
              {monthCursor.getFullYear()}年{monthCursor.getMonth() + 1}月
            </span>
            <button type="button" onClick={() => setMonthCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))} className="inline-flex size-8 items-center justify-center rounded-md border hover:bg-muted" aria-label="下个月">
              <ChevronRight className="size-4" />
            </button>
            <Button size="sm" variant="outline" onClick={() => setMonthCursor(firstOfMonth(new Date()))}>
              今天
            </Button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <span>{error}</span>
          <Button size="sm" variant="outline" render={<a href="/api/google/start" />}>
            重新连接 Google
          </Button>
        </div>
      ) : null}

      {/* 新建 / 编辑事件 */}
      {draft ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">{draft.id ? "编辑日程" : "新建日程"}</CardTitle>
            <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
              <X className="size-3" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Input placeholder="标题" value={draft.title} onChange={(e) => setDraft((d) => (d ? { ...d, title: e.target.value } : d))} />
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={draft.allDay} onChange={(e) => setDraft((d) => (d ? { ...d, allDay: e.target.checked } : d))} /> 全天
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">开始</span>
                <input
                  type={draft.allDay ? "date" : "datetime-local"}
                  value={draft.start}
                  onChange={(e) => setDraft((d) => (d ? { ...d, start: e.target.value } : d))}
                  className="h-9 w-full rounded-md border border-input bg-background px-2"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">结束（可留空）</span>
                <input
                  type={draft.allDay ? "date" : "datetime-local"}
                  value={draft.end}
                  onChange={(e) => setDraft((d) => (d ? { ...d, end: e.target.value } : d))}
                  className="h-9 w-full rounded-md border border-input bg-background px-2"
                />
              </label>
            </div>
            <Input placeholder="地点（可留空）" value={draft.location} onChange={(e) => setDraft((d) => (d ? { ...d, location: e.target.value } : d))} />
            <Textarea placeholder="备注（可留空）" value={draft.description} onChange={(e) => setDraft((d) => (d ? { ...d, description: e.target.value } : d))} className="min-h-16" />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={pending}>
                取消
              </Button>
              <Button size="sm" onClick={saveDraft} disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} 保存
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* AI 从邮件提取日程 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">AI 从邮件提取日程</CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            近
            <input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 14)))} className="h-7 w-14 rounded-md border border-input bg-background px-1.5 text-center" />
            天
            <Button size="sm" onClick={propose} disabled={aiPending}>
              {aiPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} 提取
            </Button>
          </div>
        </CardHeader>
        {candidates ? (
          <CardContent className="space-y-2 text-sm">
            {candidates.length === 0 ? (
              <p className="text-muted-foreground">近期邮件里没有找到明确的日程。</p>
            ) : (
              <>
                <div className="divide-y rounded-md border">
                  {candidates.map((c, i) => (
                    <label key={i} className="flex cursor-pointer items-start gap-2 px-3 py-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={picked.has(i)}
                        onChange={(e) =>
                          setPicked((s) => {
                            const next = new Set(s);
                            if (e.target.checked) next.add(i);
                            else next.delete(i);
                            return next;
                          })
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{c.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {c.allDay ? `${c.start.slice(0, 10)} 全天` : new Date(c.start).toLocaleString()}
                          {c.location ? ` · ${c.location}` : ""}
                        </div>
                        <div className="truncate text-xs text-muted-foreground/80">来自：{c.sourceFrom} — {c.sourceSubject ?? "(无主题)"}</div>
                      </div>
                    </label>
                  ))}
                </div>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setCandidates(null)} disabled={aiPending}>
                    取消
                  </Button>
                  <Button size="sm" onClick={addPicked} disabled={aiPending || picked.size === 0}>
                    {aiPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} 加入选中（{picked.size}）
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        ) : (
          <CardContent className="text-sm text-muted-foreground">点「提取」，AI 会分析近期邮件，找出会议、预约、面试等带时间的日程供你确认加入日历（需先在「AI 设置」配好模型）。</CardContent>
        )}
      </Card>

      {/* 月视图 */}
      {viewMode === "month" ? (
        <Card>
          <CardContent className="p-0">
            <div className="grid grid-cols-7 border-b text-center text-xs font-medium text-muted-foreground">
              {MONTH_WEEKDAYS.map((w) => (
                <div key={w} className="py-1.5">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {gridDays.map((d) => {
                const key = localKey(d);
                const dayEvents = byDay.get(key) ?? [];
                const inMonth = d.getMonth() === curMonth;
                const isToday = key === todayKey;
                return (
                  <div key={key} className={cn("group/cell min-h-24 border-b border-r p-1 [&:nth-child(7n)]:border-r-0", !inMonth && "bg-muted/30")}>
                    <div className="flex items-center justify-between">
                      <span className={cn("inline-flex size-6 items-center justify-center rounded-full text-xs", isToday && "bg-primary font-semibold text-primary-foreground", !inMonth && "text-muted-foreground")}>{d.getDate()}</span>
                      <button type="button" onClick={() => setDraft(draftOnDay(key))} className="inline-flex size-5 items-center justify-center rounded opacity-0 transition hover:bg-muted group-hover/cell:opacity-100" aria-label={`在 ${key} 新建日程`}>
                        <Plus className="size-3.5 text-muted-foreground" />
                      </button>
                    </div>
                    <div className="mt-0.5 space-y-0.5">
                      {dayEvents.slice(0, 4).map((e) => (
                        <button
                          key={`${e.calendarId}:${e.id}`}
                          type="button"
                          onClick={() => openEvent(e)}
                          title={`${timeLabel(e)} ${e.title}${e.calendarName ? `（${e.calendarName}）` : ""}`}
                          className="flex w-full items-center gap-1 truncate rounded bg-muted px-1 py-0.5 text-left text-[11px] leading-tight hover:bg-muted/70"
                        >
                          <span className="size-1.5 shrink-0 rounded-full" style={{ background: e.color ?? "#888" }} />
                          <span className="truncate">
                            {hhmm(e) ? <span className="text-muted-foreground">{hhmm(e)}</span> : null}
                            {e.title}
                          </span>
                        </button>
                      ))}
                      {dayEvents.length > 4 ? <div className="px-1 text-[10px] text-muted-foreground">还有 {dayEvents.length - 4} 项</div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ) : (
        /* 日程视图 */
        <Card>
          <CardHeader>
            <CardTitle className="text-base">日程（{events.length}）</CardTitle>
          </CardHeader>
          <CardContent className="p-0 text-sm">
            {agendaDays.length === 0 ? (
              <p className="px-4 py-3 text-muted-foreground">这段时间没有日程。</p>
            ) : (
              agendaDays.map((key) => (
                <div key={key}>
                  <div className="border-y bg-muted/40 px-4 py-1.5 text-xs font-semibold">{dayLabel(key)}</div>
                  <div className="divide-y">
                    {(byDay.get(key) ?? []).map((e) => (
                      <div key={`${e.calendarId}:${e.id}`} className="group flex items-start gap-3 px-4 py-2.5">
                        <div className="w-20 shrink-0 text-xs text-muted-foreground">{timeLabel(e)}</div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{e.title}</span>
                            {e.calendarName ? (
                              <span className="inline-flex items-center gap-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                                <span className="size-2 rounded-full" style={{ background: e.color ?? "#888" }} />
                                {e.calendarName}
                              </span>
                            ) : null}
                            {e.readOnly ? <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">只读</span> : null}
                          </div>
                          {e.location ? <div className="text-xs text-muted-foreground">📍 {e.location}</div> : null}
                          {e.description ? <div className="line-clamp-2 text-xs text-muted-foreground">{e.description}</div> : null}
                        </div>
                        <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                          {e.htmlLink ? (
                            <a href={e.htmlLink} target="_blank" rel="noreferrer" className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label="在 Google 打开">
                              <ExternalLink className="size-3.5 text-muted-foreground" />
                            </a>
                          ) : null}
                          {e.readOnly ? null : (
                            <>
                              <button type="button" onClick={() => setDraft(draftFromEvent(e))} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label="编辑">
                                <Pencil className="size-3.5 text-muted-foreground" />
                              </button>
                              <button type="button" onClick={() => remove(e)} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label="删除">
                                <Trash2 className="size-3.5 text-destructive" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
