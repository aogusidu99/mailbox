"use client";

import { ChevronDown, ChevronRight, Loader2, Pencil, Plus, RefreshCw, Trash2, Unlink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { TaskList, TaskWithList } from "@/server/google/tasks";
import { cn } from "cn";
import { createTaskAction, deleteTaskAction, disconnectGoogleAction, loadAllTasksAction, updateTaskAction } from "./actions";

interface EditDraft {
  id: string;
  listId: string;
  title: string;
  notes: string;
  due: string;
}

/** 按截止日期升序（无截止日排最后），再按标题 */
function sortActive(a: TaskWithList, b: TaskWithList): number {
  const da = a.due ?? "9999";
  const db = b.due ?? "9999";
  if (da !== db) return da.localeCompare(db);
  return a.title.localeCompare(b.title);
}

export function TasksView({
  lists,
  defaultListId,
  initialTasks,
  email,
  initialError,
  compact = false,
}: {
  lists: TaskList[];
  defaultListId: string | null;
  initialTasks: TaskWithList[];
  email: string | null;
  initialError: string | null;
  /** 紧凑模式：嵌入日历右侧面板时用，精简头部（不显示已连接/断开） */
  compact?: boolean;
}) {
  const router = useRouter();
  const [tasks, setTasks] = useState<TaskWithList[]>(initialTasks);
  const [pending, start] = useTransition();
  const [error] = useState<string | null>(initialError);

  const [newTitle, setNewTitle] = useState("");
  const [newDue, setNewDue] = useState("");
  const [addListId, setAddListId] = useState(defaultListId ?? lists[0]?.id ?? "");
  const [edit, setEdit] = useState<EditDraft | null>(null);
  // 每个清单的「已完成」默认折叠，避免长长的已完成列表把其它清单顶到很下面
  const [showDone, setShowDone] = useState<Set<string>>(new Set());
  const toggleDone = (listId: string) =>
    setShowDone((s) => {
      const next = new Set(s);
      if (next.has(listId)) next.delete(listId);
      else next.add(listId);
      return next;
    });
  // 整个清单折叠（点标题）
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (listId: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(listId)) next.delete(listId);
      else next.add(listId);
      return next;
    });

  const reload = () =>
    start(async () => {
      const r = await loadAllTasksAction();
      if (r.ok) setTasks(r.data.tasks);
      else toast.error(r.error);
    });

  const add = () =>
    start(async () => {
      const title = newTitle.trim();
      if (!title) return void toast.error("请填写任务标题");
      if (!addListId) return void toast.error("没有可用的任务清单");
      const r = await createTaskAction(addListId, { title, due: newDue || null });
      if (!r.ok) return void toast.error(r.error);
      setNewTitle("");
      setNewDue("");
      const rr = await loadAllTasksAction();
      if (rr.ok) setTasks(rr.data.tasks);
      toast.success("已添加任务");
    });

  const toggle = (t: TaskWithList) => {
    const completed = !t.completed;
    setTasks((list) => list.map((x) => (x.id === t.id && x.listId === t.listId ? { ...x, completed } : x))); // 乐观
    start(async () => {
      const r = await updateTaskAction(t.listId, t.id, { completed });
      if (!r.ok) {
        toast.error(r.error);
        setTasks((list) => list.map((x) => (x.id === t.id && x.listId === t.listId ? { ...x, completed: !completed } : x)));
      }
    });
  };

  const saveEdit = () =>
    start(async () => {
      if (!edit) return;
      if (!edit.title.trim()) return void toast.error("标题不能为空");
      const r = await updateTaskAction(edit.listId, edit.id, { title: edit.title.trim(), notes: edit.notes || null, due: edit.due || null });
      if (!r.ok) return void toast.error(r.error);
      setEdit(null);
      const rr = await loadAllTasksAction();
      if (rr.ok) setTasks(rr.data.tasks);
      toast.success("已更新");
    });

  const remove = (t: TaskWithList) =>
    start(async () => {
      if (!confirm(`删除任务「${t.title}」？`)) return;
      const r = await deleteTaskAction(t.listId, t.id);
      if (!r.ok) return void toast.error(r.error);
      setTasks((list) => list.filter((x) => !(x.id === t.id && x.listId === t.listId)));
      toast.success("已删除");
    });

  const disconnect = () =>
    start(async () => {
      if (!confirm("断开 Google 连接？（不会删除 Google 上的数据）")) return;
      const r = await disconnectGoogleAction();
      if (!r.ok) return void toast.error(r.error);
      router.refresh();
    });

  // 按清单分组，与 Google 任务的多清单结构一一对应
  const byList = useMemo(() => {
    const map = new Map<string, { active: TaskWithList[]; done: TaskWithList[] }>();
    for (const l of lists) map.set(l.id, { active: [], done: [] });
    for (const t of tasks) {
      if (!map.has(t.listId)) map.set(t.listId, { active: [], done: [] });
      const bucket = map.get(t.listId)!;
      (t.completed ? bucket.done : bucket.active).push(t);
    }
    for (const b of map.values()) b.active.sort(sortActive);
    return map;
  }, [lists, tasks]);
  const totalActive = useMemo(() => tasks.filter((t) => !t.completed).length, [tasks]);

  const renderTask = (t: TaskWithList) => (
    <div key={`${t.listId}:${t.id}`} className="group px-4 py-2.5">
      {edit?.id === t.id && edit.listId === t.listId ? (
        <div className="space-y-2">
          <Input value={edit.title} onChange={(e) => setEdit((d) => (d ? { ...d, title: e.target.value } : d))} placeholder="标题" />
          <Textarea value={edit.notes} onChange={(e) => setEdit((d) => (d ? { ...d, notes: e.target.value } : d))} placeholder="备注" className="min-h-14" />
          <div className="flex items-center gap-2">
            <input type="date" value={edit.due} onChange={(e) => setEdit((d) => (d ? { ...d, due: e.target.value } : d))} className="h-9 rounded-md border border-input bg-background px-2 text-sm" />
            <div className="flex-1" />
            <Button size="xs" variant="ghost" onClick={() => setEdit(null)} disabled={pending}>
              取消
            </Button>
            <Button size="xs" onClick={saveEdit} disabled={pending}>
              保存
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <input type="checkbox" checked={t.completed} disabled={pending} onChange={() => toggle(t)} className="mt-1" aria-label={`完成 ${t.title}`} />
          <div className="min-w-0 flex-1">
            <div className={cn("font-medium", t.completed && "text-muted-foreground line-through")}>{t.title}</div>
            {t.notes ? <div className="whitespace-pre-wrap text-xs text-muted-foreground">{t.notes}</div> : null}
            {t.due ? <div className="text-xs text-muted-foreground">截止：{t.due.slice(0, 10)}</div> : null}
          </div>
          <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
            <button
              type="button"
              onClick={() => setEdit({ id: t.id, listId: t.listId, title: t.title, notes: t.notes ?? "", due: t.due ? t.due.slice(0, 10) : "" })}
              className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted"
              aria-label="编辑"
            >
              <Pencil className="size-3.5 text-muted-foreground" />
            </button>
            <button type="button" onClick={() => remove(t)} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted" aria-label="删除">
              <Trash2 className="size-3.5 text-destructive" />
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {compact ? (
          <div className="text-sm font-semibold">
            任务 <span className="ml-1 text-xs font-normal text-muted-foreground">待办 {totalActive}</span>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            已连接 <span className="font-medium text-foreground">{email ?? "Google"}</span>
            <span className="ml-2 text-xs">（{lists.length} 个清单 · 待办 {totalActive}）</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={reload} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} 刷新
          </Button>
          {compact ? null : (
            <Button size="sm" variant="ghost" onClick={disconnect} disabled={pending}>
              <Unlink className="size-4" /> 断开
            </Button>
          )}
        </div>
      </div>

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <span>{error}</span>
          <Button size="sm" variant="outline" render={<a href="/api/google/start" />}>
            重新连接 Google
          </Button>
        </div>
      ) : null}

      {/* 新增任务 */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 py-3">
          <Input
            placeholder="添加任务…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            className="min-w-40 flex-1"
          />
          <input type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-sm" aria-label="截止日期" />
          {lists.length > 1 ? (
            <select value={addListId} onChange={(e) => setAddListId(e.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-sm" aria-label="加入清单">
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
          ) : null}
          <Button size="sm" onClick={add} disabled={pending || !newTitle.trim()}>
            <Plus className="size-4" /> 添加
          </Button>
        </CardContent>
      </Card>

      {/* 按清单分组（与 Google 任务清单一一对应） */}
      {lists.length === 0 ? (
        <Card>
          <CardContent className="py-3 text-sm text-muted-foreground">还没有任务清单。</CardContent>
        </Card>
      ) : (
        lists.map((l) => {
          const b = byList.get(l.id) ?? { active: [], done: [] };
          return (
            <Card key={l.id}>
              <button type="button" onClick={() => toggleCollapsed(l.id)} className="flex w-full items-center gap-1 px-4 py-3 text-left hover:bg-muted/40" aria-expanded={!collapsed.has(l.id)}>
                {collapsed.has(l.id) ? <ChevronRight className="size-4 shrink-0" /> : <ChevronDown className="size-4 shrink-0" />}
                <CardTitle className="text-base">
                  {l.title}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    待办 {b.active.length}
                    {b.done.length ? ` · 已完成 ${b.done.length}` : ""}
                  </span>
                </CardTitle>
              </button>
              <CardContent className={cn("p-0 text-sm", collapsed.has(l.id) && "hidden")}>
                {b.active.length === 0 && b.done.length === 0 ? (
                  <p className="px-4 py-3 text-muted-foreground">暂无任务。</p>
                ) : (
                  <>
                    <div className="divide-y">{b.active.map(renderTask)}</div>
                    {b.done.length ? (
                      <>
                        <button
                          type="button"
                          onClick={() => toggleDone(l.id)}
                          className="flex w-full items-center gap-1 border-y bg-muted/40 px-4 py-1.5 text-left text-xs font-semibold hover:bg-muted/60"
                        >
                          {showDone.has(l.id) ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                          已完成 {b.done.length}
                        </button>
                        {showDone.has(l.id) ? <div className="divide-y opacity-70">{b.done.map(renderTask)}</div> : null}
                      </>
                    ) : null}
                  </>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
