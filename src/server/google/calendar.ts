import { googleFetch } from "./api";

/**
 * Google 日历（Calendar API v3）：**只读**——读取用户所有已勾选日历的事件并合并，作为日历页背景展示。
 * 日程/待办本身统一以 Google 任务承载（见 tasks.ts），mailbox 不再创建/修改日历事件。
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

/** 用户的日历列表（只保留已勾选显示的） */
async function listVisibleCalendars(userId: string): Promise<CalendarListEntry[]> {
  const data = await googleFetch<{ items?: CalendarListEntry[] }>(userId, `${BASE}/users/me/calendarList?minAccessRole=freeBusyReader`);
  return (data.items ?? []).filter((c) => c.selected !== false);
}

/**
 * 列出某时间窗内**所有已勾选日历**的事件（默认过去 7 天到未来 60 天），按开始时间排序。
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
