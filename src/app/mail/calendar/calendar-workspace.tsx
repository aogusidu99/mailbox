"use client";

import { CalendarPlus, Check, ChevronLeft, ChevronRight, ExternalLink, Loader2, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, Unlink, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CalEvent, CalEventInput, CalendarMeta } from "@/server/google/calendar";
import type { EventCandidate } from "@/server/google/extract-events";
import type { TaskList, TaskWithList } from "@/server/google/tasks";
import { cn } from "cn";
import { TasksView } from "../tasks/tasks-view";
import { addEventsAction, createEventAction, deleteEventAction, disconnectGoogleAction, proposeEventsAction, refreshEventsAction, updateEventAction } from "./actions";

interface Draft {
  id: string | null;
  calendarId: string;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  location: string;
  description: string;
}

type ViewMode = "month" | "week" | "agenda";

/** 合成的「任务」日历：把带截止日的 Google 任务叠加显示在日历上（Google 日历的 Tasks 图层等价物） */
const TASK_CAL: CalendarMeta = { id: "__tasks__", name: "任务", color: "#0b8043", primary: false, readOnly: true };

// ---------- 日期辅助 ----------
const WK = ["一", "二", "三", "四", "五", "六", "日"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const localKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const firstOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const eventDayKey = (e: CalEvent) => {
  const d = new Date(e.start);
  return Number.isNaN(d.getTime()) ? e.start.slice(0, 10) : localKey(d);
};
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
const hhmm = (e: CalEvent) => {
  if (e.allDay) return "";
  const d = new Date(e.start);
  return Number.isNaN(d.getTime()) ? "" : `${pad2(d.getHours())}:${pad2(d.getMinutes())} `;
};
const monday = (d: Date) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
function monthGrid(cursor: Date): Date[] {
  const first = firstOfMonth(cursor);
  const gridStart = monday(first);
  return Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
}
const weekDays = (cursor: Date): Date[] => {
  const m = monday(cursor);
  return Array.from({ length: 7 }, (_, i) => new Date(m.getFullYear(), m.getMonth(), m.getDate() + i));
};
function rangeIso(view: ViewMode, cursor: Date): { from: string; to: string } {
  if (view === "agenda") {
    const now = Date.now();
    return { from: new Date(now - 90 * 86_400_000).toISOString(), to: new Date(now + 366 * 86_400_000).toISOString() };
  }
  if (view === "week") {
    const d = weekDays(cursor);
    return { from: d[0].toISOString(), to: new Date(d[6].getFullYear(), d[6].getMonth(), d[6].getDate() + 1).toISOString() };
  }
  const g = monthGrid(cursor);
  return { from: g[0].toISOString(), to: new Date(g[41].getFullYear(), g[41].getMonth(), g[41].getDate() + 1).toISOString() };
}
function dayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00`);
  const isToday = d.toDateString() === new Date().toDateString();
  return `${key.slice(5)} ${WK[(d.getDay() + 6) % 7]}${isToday ? "（今天）" : ""}`;
}

function emptyDraft(dateKey?: string): Draft {
  const start = dateKey ? `${dateKey}T09:00` : toLocalInput(new Date(Date.now() + 3_600_000).toISOString());
  return { id: null, calendarId: "primary", title: "", allDay: false, start, end: "", location: "", description: "" };
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
  if (d.allDay) return { title: d.title.trim(), allDay: true, start: d.start, end: d.end || null, location: d.location || null, description: d.description || null };
  return {
    title: d.title.trim(),
    allDay: false,
    start: new Date(d.start).toISOString(),
    end: d.end ? new Date(d.end).toISOString() : null,
    location: d.location || null,
    description: d.description || null,
  };
}

// ---------- 小日历（无状态，跟随 cursor；翻月改主 cursor） ----------
function MiniCalendar({ cursor, onPick, onShiftMonth }: { cursor: Date; onPick: (d: Date) => void; onShiftMonth: (delta: number) => void }) {
  const days = monthGrid(cursor);
  const todayKey = localKey(new Date());
  const curKey = localKey(cursor);
  return (
    <div className="text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium">{cursor.getFullYear()}年{cursor.getMonth() + 1}月</span>
        <div className="flex gap-0.5">
          <button type="button" onClick={() => onShiftMonth(-1)} className="inline-flex size-5 items-center justify-center rounded hover:bg-muted" aria-label="上个月">
            <ChevronLeft className="size-3.5" />
          </button>
          <button type="button" onClick={() => onShiftMonth(1)} className="inline-flex size-5 items-center justify-center rounded hover:bg-muted" aria-label="下个月">
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] text-muted-foreground">
        {WK.map((w) => (
          <div key={w} className="py-0.5">{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 text-center">
        {days.map((d) => {
          const k = localKey(d);
          return (
            <button
              key={k}
              type="button"
              onClick={() => onPick(d)}
              className={cn(
                "mx-auto my-0.5 inline-flex size-6 items-center justify-center rounded-full",
                d.getMonth() !== cursor.getMonth() && "text-muted-foreground/50",
                k === todayKey && "font-semibold text-primary",
                k === curKey && "bg-primary text-primary-foreground",
              )}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CalendarWorkspace({
  initialEvents,
  calendars,
  email,
  initialError,
  tasks,
}: {
  initialEvents: CalEvent[];
  calendars: CalendarMeta[];
  email: string | null;
  initialError: string | null;
  tasks: { lists: TaskList[]; defaultListId: string; initialTasks: TaskWithList[] };
}) {
  const router = useRouter();
  const [events, setEvents] = useState<CalEvent[]>(initialEvents);
  const [pending, start] = useTransition();
  const [error] = useState<string | null>(initialError);

  const [view, setView] = useState<ViewMode>("month");
  const [cursor, setCursor] = useState<Date>(() => new Date());
  const [hiddenCals, setHiddenCals] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);

  const [days, setDays] = useState(14);
  const [candidates, setCandidates] = useState<EventCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [showAi, setShowAi] = useState(false);
  const [aiPending, startAi] = useTransition();

  const monthKey = `${cursor.getFullYear()}-${cursor.getMonth()}`;
  const refreshCurrent = async () => {
    const r = await refreshEventsAction(rangeIso(view, cursor));
    if (r.ok) setEvents(r.data.events);
    return r;
  };
  useEffect(() => {
    const range = rangeIso(view, cursor);
    start(async () => {
      const r = await refreshEventsAction(range);
      if (r.ok) setEvents(r.data.events);
      else toast.error(r.error);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, monthKey]);

  const reload = () => start(async () => void (await refreshCurrent()));
  const toggleCal = (id: string) =>
    setHiddenCals((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const saveDraft = () =>
    start(async () => {
      if (!draft) return;
      if (!draft.title.trim()) return void toast.error("请填写标题");
      if (!draft.start) return void toast.error("请填写开始时间");
      const input = draftToInput(draft);
      const r = draft.id ? await updateEventAction(draft.calendarId, draft.id, input) : await createEventAction(input, draft.calendarId);
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
  const openEvent = (e: CalEvent) => (e.readOnly ? e.htmlLink && window.open(e.htmlLink, "_blank") : setDraft(draftFromEvent(e)));

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
      setShowAi(false);
      await refreshCurrent();
    });

  // 带截止日的任务 → 合成的「任务」日历事件（全天，只读），叠加到日历
  const taskEvents = useMemo<CalEvent[]>(() => {
    return tasks.initialTasks
      .filter((t) => t.due)
      .map((t) => ({
        id: `task:${t.listId}:${t.id}`,
        title: t.completed ? `✓ ${t.title}` : t.title,
        description: t.notes ?? null,
        location: null,
        start: t.due!.slice(0, 10),
        end: null,
        allDay: true,
        htmlLink: null,
        calendarId: TASK_CAL.id,
        calendarName: TASK_CAL.name,
        color: TASK_CAL.color,
        readOnly: true,
      }));
  }, [tasks.initialTasks]);

  // 按日历勾选 + 搜索过滤（真实事件 + 任务图层）
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...events, ...taskEvents].filter((e) => !hiddenCals.has(e.calendarId) && (!q || `${e.title} ${e.location ?? ""} ${e.description ?? ""}`.toLowerCase().includes(q)));
  }, [events, taskEvents, hiddenCals, query]);
  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of visible) {
      const k = eventDayKey(e);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    return m;
  }, [visible]);
  const todayKey = localKey(new Date());
  // 日程视图：从左侧小日历选中的日期开始往后显示
  const agendaDays = useMemo(() => [...byDay.keys()].filter((k) => k >= localKey(cursor)).sort(), [byDay, cursor]);

  const rangeTitle =
    view === "agenda"
      ? "日程"
      : view === "week"
        ? (() => {
            const d = weekDays(cursor);
            return `${localKey(d[0]).slice(5)} ~ ${localKey(d[6]).slice(5)}`;
          })()
        : `${cursor.getFullYear()}年${cursor.getMonth() + 1}月`;
  const shift = (dir: number) => {
    if (view === "month") setCursor((c) => new Date(c.getFullYear(), c.getMonth() + dir, 1));
    else if (view === "week") setCursor((c) => new Date(c.getFullYear(), c.getMonth(), c.getDate() + dir * 7));
    else setCursor((c) => new Date(c.getFullYear(), c.getMonth(), c.getDate() + dir));
  };

  const eventChip = (e: CalEvent, key: string) => (
    <button key={key} type="button" onClick={() => openEvent(e)} title={`${timeLabel(e)} ${e.title}${e.calendarName ? `（${e.calendarName}）` : ""}`} className="flex w-full items-center gap-1 truncate rounded bg-muted px-1 py-0.5 text-left text-[11px] leading-tight hover:bg-muted/70">
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: e.color ?? "#888" }} />
      <span className="truncate">
        {hhmm(e) ? <span className="text-muted-foreground">{hhmm(e)}</span> : null}
        {e.title}
      </span>
    </button>
  );

  return (
    <div className="flex h-full min-h-0">
      {/* 左：控制栏（宽屏 xl+ 才显示；更窄时新建/视图在中间工具栏） */}
      <aside className="hidden w-52 shrink-0 flex-col gap-3 overflow-y-auto border-r p-3 xl:flex">
        <Button size="sm" onClick={() => setDraft(emptyDraft())} disabled={pending}>
          <CalendarPlus className="size-4" /> 新建日程
        </Button>
        <MiniCalendar cursor={cursor} onPick={(d) => setCursor(d)} onShiftMonth={(delta) => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1))} />
        <div>
          <div className="mb-1 text-xs font-semibold text-muted-foreground">显示的日历</div>
          <div className="space-y-1">
            {[...calendars, TASK_CAL].map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 text-xs">
                <input type="checkbox" checked={!hiddenCals.has(c.id)} onChange={() => toggleCal(c.id)} style={{ accentColor: c.color ?? undefined }} />
                <span className="size-2 shrink-0 rounded-full" style={{ background: c.color ?? "#888" }} />
                <span className="truncate">{c.name}</span>
              </label>
            ))}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowAi((v) => !v)}>
          <Sparkles className="size-4" /> AI 从邮件提取日程
        </Button>
        <div className="mt-auto">
          <Button size="xs" variant="ghost" onClick={disconnect} disabled={pending} className="text-muted-foreground">
            <Unlink className="size-3.5" /> 断开 {email ?? ""}
          </Button>
        </div>
      </aside>

      {/* 中：日历 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 工具栏 */}
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <Button size="sm" onClick={() => setDraft(emptyDraft())} disabled={pending} className="xl:hidden">
            <CalendarPlus className="size-4" /> 新建
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowAi((v) => !v)} className="xl:hidden" aria-label="AI 提取日程">
            <Sparkles className="size-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCursor(new Date())}>今天</Button>
          <div className="flex items-center gap-0.5">
            <button type="button" onClick={() => shift(-1)} className="inline-flex size-8 items-center justify-center rounded-md border hover:bg-muted" aria-label="上一段">
              <ChevronLeft className="size-4" />
            </button>
            <button type="button" onClick={() => shift(1)} className="inline-flex size-8 items-center justify-center rounded-md border hover:bg-muted" aria-label="下一段">
              <ChevronRight className="size-4" />
            </button>
          </div>
          <span className="text-sm font-medium">{rangeTitle}</span>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索" className="h-8 w-24 pl-7 sm:w-40" />
            </div>
            <div className="inline-flex shrink-0 overflow-hidden rounded-md border text-sm">
              {(["month", "week", "agenda"] as ViewMode[]).map((v) => (
                <button key={v} type="button" onClick={() => setView(v)} className={cn("whitespace-nowrap px-2.5 py-1.5", view === v ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
                  {v === "month" ? "月" : v === "week" ? "周" : "日程"}
                </button>
              ))}
            </div>
            <Button size="sm" variant="outline" onClick={reload} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {error ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <span>{error}</span>
              <Button size="sm" variant="outline" render={<a href="/api/google/start" />}>重新连接 Google</Button>
            </div>
          ) : null}

          {/* 新建/编辑事件 */}
          {draft ? (
            <Card className="mb-3">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">{draft.id ? "编辑日程" : "新建日程"}</CardTitle>
                <Button size="xs" variant="ghost" onClick={() => setDraft(null)}><X className="size-3" /></Button>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Input placeholder="标题" value={draft.title} onChange={(e) => setDraft((d) => (d ? { ...d, title: e.target.value } : d))} />
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={draft.allDay} onChange={(e) => setDraft((d) => (d ? { ...d, allDay: e.target.checked } : d))} /> 全天
                  </label>
                  {draft.id === null && calendars.some((c) => !c.readOnly) ? (
                    <label className="flex items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground">日历</span>
                      <select value={draft.calendarId} onChange={(e) => setDraft((d) => (d ? { ...d, calendarId: e.target.value } : d))} className="h-8 rounded-md border border-input bg-background px-2">
                        {calendars.filter((c) => !c.readOnly).map((c) => (
                          <option key={c.id} value={c.primary ? "primary" : c.id}>
                            {c.primary ? "我的日历" : c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">开始</span>
                    <input type={draft.allDay ? "date" : "datetime-local"} value={draft.start} onChange={(e) => setDraft((d) => (d ? { ...d, start: e.target.value } : d))} className="h-9 w-full rounded-md border border-input bg-background px-2" />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">结束（可留空）</span>
                    <input type={draft.allDay ? "date" : "datetime-local"} value={draft.end} onChange={(e) => setDraft((d) => (d ? { ...d, end: e.target.value } : d))} className="h-9 w-full rounded-md border border-input bg-background px-2" />
                  </label>
                </div>
                <Input placeholder="地点（可留空）" value={draft.location} onChange={(e) => setDraft((d) => (d ? { ...d, location: e.target.value } : d))} />
                <Textarea placeholder="备注（可留空）" value={draft.description} onChange={(e) => setDraft((d) => (d ? { ...d, description: e.target.value } : d))} className="min-h-14" />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={pending}>取消</Button>
                  <Button size="sm" onClick={saveDraft} disabled={pending}>{pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} 保存</Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* AI 提取 */}
          {showAi ? (
            <Card className="mb-3">
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="text-base">AI 从邮件提取日程</CardTitle>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  近<input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 14)))} className="h-7 w-14 rounded-md border border-input bg-background px-1.5 text-center" />天
                  <Button size="sm" onClick={propose} disabled={aiPending}>{aiPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} 提取</Button>
                  <Button size="xs" variant="ghost" onClick={() => { setShowAi(false); setCandidates(null); }}><X className="size-3" /></Button>
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
                            <input type="checkbox" className="mt-1" checked={picked.has(i)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(i); else n.delete(i); return n; })} />
                            <div className="min-w-0 flex-1">
                              <div className="font-medium">{c.title}</div>
                              <div className="text-xs text-muted-foreground">{c.allDay ? `${c.start.slice(0, 10)} 全天` : new Date(c.start).toLocaleString()}{c.location ? ` · ${c.location}` : ""}</div>
                              <div className="truncate text-xs text-muted-foreground/80">来自：{c.sourceFrom} — {c.sourceSubject ?? "(无主题)"}</div>
                            </div>
                          </label>
                        ))}
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button size="sm" onClick={addPicked} disabled={aiPending || picked.size === 0}>{aiPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} 加入选中（{picked.size}）</Button>
                      </div>
                    </>
                  )}
                </CardContent>
              ) : (
                <CardContent className="text-sm text-muted-foreground">点「提取」，AI 会分析近期邮件，找出会议、预约等带时间的日程供你确认加入日历。</CardContent>
              )}
            </Card>
          ) : null}

          {/* 视图主体 */}
          {view === "month" ? (
            <Card>
              <CardContent className="p-0">
                <div className="grid grid-cols-7 border-b text-center text-xs font-medium text-muted-foreground">
                  {WK.map((w) => (<div key={w} className="py-1.5">{w}</div>))}
                </div>
                <div className="grid grid-cols-7">
                  {monthGrid(cursor).map((d) => {
                    const key = localKey(d);
                    const de = byDay.get(key) ?? [];
                    const inMonth = d.getMonth() === cursor.getMonth();
                    return (
                      <div key={key} className={cn("group/cell min-h-24 border-b border-r p-1 [&:nth-child(7n)]:border-r-0", !inMonth && "bg-muted/30")}>
                        <div className="flex items-center justify-between">
                          <span className={cn("inline-flex size-6 items-center justify-center rounded-full text-xs", key === todayKey && "bg-primary font-semibold text-primary-foreground", !inMonth && "text-muted-foreground")}>{d.getDate()}</span>
                          <button type="button" onClick={() => setDraft(emptyDraft(key))} className="inline-flex size-5 items-center justify-center rounded opacity-0 transition hover:bg-muted group-hover/cell:opacity-100" aria-label="新建"><Plus className="size-3.5 text-muted-foreground" /></button>
                        </div>
                        <div className="mt-0.5 space-y-0.5">
                          {de.slice(0, 4).map((e) => eventChip(e, `${e.calendarId}:${e.id}`))}
                          {de.length > 4 ? <div className="px-1 text-[10px] text-muted-foreground">还有 {de.length - 4} 项</div> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ) : view === "week" ? (
            <Card>
              <CardContent className="grid grid-cols-7 p-0">
                {weekDays(cursor).map((d) => {
                  const key = localKey(d);
                  const de = byDay.get(key) ?? [];
                  return (
                    <div key={key} className="group/cell min-h-72 border-r p-1 last:border-r-0">
                      <div className="mb-1 flex items-center justify-between border-b pb-1">
                        <span className={cn("text-xs font-medium", key === todayKey && "text-primary")}>{WK[(d.getDay() + 6) % 7]} {d.getDate()}</span>
                        <button type="button" onClick={() => setDraft(emptyDraft(key))} className="inline-flex size-5 items-center justify-center rounded opacity-0 transition hover:bg-muted group-hover/cell:opacity-100" aria-label="新建"><Plus className="size-3.5 text-muted-foreground" /></button>
                      </div>
                      <div className="space-y-0.5">{de.map((e) => eventChip(e, `${e.calendarId}:${e.id}`))}</div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : (
            <Card>
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
                                {e.calendarName ? <span className="inline-flex items-center gap-1 rounded bg-muted px-1 text-[10px] text-muted-foreground"><span className="size-2 rounded-full" style={{ background: e.color ?? "#888" }} />{e.calendarName}</span> : null}
                                {e.readOnly ? <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">只读</span> : null}
                              </div>
                              {e.location ? <div className="text-xs text-muted-foreground">📍 {e.location}</div> : null}
                            </div>
                            <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                              {e.htmlLink ? <a href={e.htmlLink} target="_blank" rel="noreferrer" className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label="在 Google 打开"><ExternalLink className="size-3.5 text-muted-foreground" /></a> : null}
                              {e.readOnly ? null : (
                                <>
                                  <button type="button" onClick={() => setDraft(draftFromEvent(e))} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label="编辑"><Pencil className="size-3.5 text-muted-foreground" /></button>
                                  <button type="button" onClick={() => remove(e)} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label="删除"><Trash2 className="size-3.5 text-destructive" /></button>
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
      </div>

      {/* 右：任务（lg+ 显示，宽度随屏增长；更窄时用侧栏「谷歌任务」标签页） */}
      <aside className="hidden w-72 shrink-0 overflow-y-auto border-l p-3 lg:block xl:w-96 2xl:w-[28rem]">
        <TasksView compact lists={tasks.lists} defaultListId={tasks.defaultListId} initialTasks={tasks.initialTasks} email={email} initialError={null} />
      </aside>
    </div>
  );
}
