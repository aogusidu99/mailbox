"use server";

import { requireUser } from "@/server/auth/session";
import { createEvent, deleteEvent, listEvents, updateEvent, type CalEventInput } from "@/server/google/calendar";
import { disconnectGoogle } from "@/server/google/connection";
import { addEventsToCalendar, proposeCalendarEvents } from "@/server/google/extract-events";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 重新拉取事件；不传范围用默认窗口（日程视图），传范围按范围拉（月视图） */
export async function refreshEventsAction(range?: { from: string; to: string }) {
  return run(async () => {
    const user = await requireUser();
    const opts = range ? { timeMin: new Date(range.from), timeMax: new Date(range.to), max: 250 } : { max: 250 };
    return { events: await listEvents(user.id, opts) };
  });
}

export async function createEventAction(input: CalEventInput, calendarId?: string) {
  return run(async () => {
    const user = await requireUser();
    if (!input.title.trim()) throw new Error("请填写标题");
    if (!input.start) throw new Error("请填写开始时间");
    return createEvent(user.id, input, calendarId || "primary");
  });
}

export async function updateEventAction(calendarId: string, eventId: string, input: CalEventInput) {
  return run(async () => {
    const user = await requireUser();
    return updateEvent(user.id, calendarId, eventId, input);
  });
}

export async function deleteEventAction(calendarId: string, eventId: string) {
  return run(async () => {
    const user = await requireUser();
    await deleteEvent(user.id, calendarId, eventId);
  });
}

/** AI 从近期邮件抽取日程（带时间） */
export async function proposeEventsAction(days: number) {
  return run(async () => {
    const user = await requireUser();
    return proposeCalendarEvents(user.id, { days });
  });
}

/** 把选中的候选事件加入日历 */
export async function addEventsAction(events: CalEventInput[]) {
  return run(async () => {
    const user = await requireUser();
    if (events.length === 0) throw new Error("请先选择要加入的日程");
    return addEventsToCalendar(user.id, events);
  });
}

export async function disconnectGoogleAction() {
  return run(async () => {
    const user = await requireUser();
    await disconnectGoogle(user.id);
  });
}
