import { googleFetch } from "./api";

/**
 * Google 日历（Calendar API v3）：读取用户所有已勾选日历的事件并合并展示；对主日历（primary）增删改真实事件。
 * 日程（会议/约会，带时间）用日历事件承载；待办（有截止日）用 Google 任务承载（见 tasks.ts），两者分开。
 */

const BASE = "https://www.googleapis.com/calendar/v3";

/** 简化的事件结构（给前端用） */
export interface CalEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  /** 定时事件：ISO 8601（带时区）；全天事件：YYYY-MM-DD */
  start: string;
  end: string | null;
  allDay: boolean;
  htmlLink: string | null;
  /** 事件所属日历（编辑/删除需要） */
  calendarId: string;
  calendarName: string | null;
  /** 日历颜色（backgroundColor），用于列表里的小圆点 */
  color: string | null;
  /** 只读日历（如订阅的节假日）里的事件不可改删 */
  readOnly: boolean;
}

/** 新建 / 编辑事件时的入参 */
export interface CalEventInput {
  title: string;
  description?: string | null;
  location?: string | null;
  /** 定时：ISO 8601 或 datetime-local；全天：YYYY-MM-DD */
  start: string;
  end?: string | null;
  allDay?: boolean;
}

interface GoogleEventDate {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}
interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventDate;
  end?: GoogleEventDate;
  htmlLink?: string;
  status?: string;
}
interface CalendarListEntry {
  id: string;
  summary?: string;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string;
  selected?: boolean;
}

function toBaseEvent(e: GoogleEvent): Omit<CalEvent, "calendarId" | "calendarName" | "color" | "readOnly"> {
  const allDay = Boolean(e.start?.date);
  return {
    id: e.id,
    title: e.summary ?? "(无标题)",
    description: e.description ?? null,
    location: e.location ?? null,
    start: (allDay ? e.start?.date : e.start?.dateTime) ?? "",
    end: (allDay ? e.end?.date : e.end?.dateTime) ?? null,
    allDay,
    htmlLink: e.htmlLink ?? null,
  };
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 把简化入参转成 Google 事件 body */
function toGoogleBody(input: CalEventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: input.title,
    description: input.description || undefined,
    location: input.location || undefined,
  };
  if (input.allDay) {
    // 全天：end.date 是排他的（次日），未给 end 时默认当天
    const startDate = input.start.slice(0, 10);
    const endDate = (input.end ?? input.start).slice(0, 10);
    body.start = { date: startDate };
    body.end = { date: endDate > startDate ? endDate : addDays(startDate, 1) };
  } else {
    const startIso = new Date(input.start).toISOString();
    const endIso = input.end ? new Date(input.end).toISOString() : new Date(new Date(input.start).getTime() + 3_600_000).toISOString();
    body.start = { dateTime: startIso };
    body.end = { dateTime: endIso };
  }
  return body;
}

/** 用户的日历列表（只保留已勾选显示的） */
async function listVisibleCalendars(userId: string): Promise<CalendarListEntry[]> {
  const data = await googleFetch<{ items?: CalendarListEntry[] }>(userId, `${BASE}/users/me/calendarList?minAccessRole=freeBusyReader`);
  return (data.items ?? []).filter((c) => c.selected !== false);
}

/** 日历元信息（给前端左侧「日历显示」勾选用） */
export interface CalendarMeta {
  id: string;
  name: string;
  color: string | null;
  primary: boolean;
  readOnly: boolean;
}

/** 列出用户所有已勾选的日历（含颜色、是否只读），供前端显示/隐藏切换 */
export async function listCalendars(userId: string): Promise<CalendarMeta[]> {
  const cals = await listVisibleCalendars(userId);
  return cals.map((c) => ({
    id: c.id,
    name: c.summary ?? "(未命名)",
    color: c.backgroundColor ?? null,
    primary: Boolean(c.primary),
    readOnly: c.accessRole === "reader" || c.accessRole === "freeBusyReader",
  }));
}

/**
 * 列出某时间窗内所有已勾选日历的事件（默认过去 7 天到未来 60 天），按开始时间排序。
 * 单个日历拉取失败（如权限问题）时跳过，不影响其它日历。
 */
export async function listEvents(userId: string, opts: { timeMin?: Date; timeMax?: Date; max?: number } = {}): Promise<CalEvent[]> {
  const timeMin = opts.timeMin ?? new Date(Date.now() - 7 * 86_400_000);
  const timeMax = opts.timeMax ?? new Date(Date.now() + 60 * 86_400_000);
  const calendars = await listVisibleCalendars(userId);
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(opts.max ?? 250),
  });
  const perCalendar = await Promise.all(
    calendars.map(async (c) => {
      try {
        const data = await googleFetch<{ items?: GoogleEvent[] }>(userId, `${BASE}/calendars/${encodeURIComponent(c.id)}/events?${params.toString()}`);
        const readOnly = c.accessRole === "reader" || c.accessRole === "freeBusyReader";
        return (data.items ?? []).map((e) => ({ ...toBaseEvent(e), calendarId: c.id, calendarName: c.summary ?? null, color: c.backgroundColor ?? null, readOnly }));
      } catch {
        return [] as CalEvent[];
      }
    }),
  );
  return perCalendar.flat().sort((a, b) => a.start.localeCompare(b.start));
}

export async function createEvent(userId: string, input: CalEventInput, calendarId = "primary"): Promise<CalEvent> {
  const e = await googleFetch<GoogleEvent>(userId, `${BASE}/calendars/${encodeURIComponent(calendarId)}/events`, { method: "POST", body: JSON.stringify(toGoogleBody(input)) });
  return { ...toBaseEvent(e), calendarId, calendarName: null, color: null, readOnly: false };
}

export async function updateEvent(userId: string, calendarId: string, eventId: string, input: CalEventInput): Promise<CalEvent> {
  const e = await googleFetch<GoogleEvent>(userId, `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: JSON.stringify(toGoogleBody(input)),
  });
  return { ...toBaseEvent(e), calendarId, calendarName: null, color: null, readOnly: false };
}

export async function deleteEvent(userId: string, calendarId: string, eventId: string): Promise<void> {
  await googleFetch(userId, `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
}
