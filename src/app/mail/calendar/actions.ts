"use server";

import { requireUser } from "@/server/auth/session";
import { listEvents } from "@/server/google/calendar";
import { disconnectGoogle } from "@/server/google/connection";
import { addScheduleAsTasks, proposeCalendarEvents } from "@/server/google/extract-events";
import { getDefaultTaskListId, listAllTasks } from "@/server/google/tasks";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 重新拉取日历页数据：Google 任务（可编辑，按截止日显示）+ 只读的真实日历事件（节假日/外部日历等背景）。
 * 传范围时按范围拉事件（月视图），不传用默认窗口。
 */
export async function refreshCalendarAction(range?: { from: string; to: string }) {
  return run(async () => {
    const user = await requireUser();
    const evOpts = range ? { timeMin: new Date(range.from), timeMax: new Date(range.to), max: 250 } : { max: 250 };
    const [events, all, defaultId] = await Promise.all([
      listEvents(user.id, evOpts).catch(() => []),
      listAllTasks(user.id),
      getDefaultTaskListId(user.id),
    ]);
    return { events, tasks: all.tasks, lists: all.lists, defaultListId: defaultId ?? all.lists[0]?.id ?? "@default" };
  });
}

/** AI 从近期邮件抽取日程（只到日） */
export async function proposeScheduleAction(days: number) {
  return run(async () => {
    const user = await requireUser();
    return proposeCalendarEvents(user.id, { days });
  });
}

/** 把选中的候选写入 Google 任务（默认清单） */
export async function addScheduleAction(items: Array<{ title: string; date: string; location: string | null; note: string | null }>, listId?: string) {
  return run(async () => {
    const user = await requireUser();
    if (items.length === 0) throw new Error("请先选择要加入的日程");
    return addScheduleAsTasks(user.id, items, listId || "@default");
  });
}

export async function disconnectGoogleAction() {
  return run(async () => {
    const user = await requireUser();
    await disconnectGoogle(user.id);
  });
}
