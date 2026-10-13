import type { EmailAddress } from "@/db/schema";

/**
 * 日期一律按此时区显示，和服务端每日摘要「按天」的时区保持一致（容器 TZ=Asia/Shanghai）。
 * 否则当客户端运行时为 UTC 时（如桌面端内嵌浏览器），列表里凌晨的邮件会比真实（中国）日期早一天，
 * 让人误以为摘要漏了邮件。
 */
const DISPLAY_TZ = "Asia/Shanghai";

/** 某时刻在显示时区下的 YYYY-MM-DD（用于判断是否同一天/同一年，不受运行时时区影响） */
function tzDateKey(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: DISPLAY_TZ }); // en-CA → YYYY-MM-DD
}

/** 列表用日期：今天显示时间，今年显示月日，否则显示年月日（均按 DISPLAY_TZ）。 */
export function formatListDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dk = tzDateKey(d);
  const nk = tzDateKey(new Date());
  if (dk === nk) return d.toLocaleTimeString("zh-CN", { timeZone: DISPLAY_TZ, hour: "2-digit", minute: "2-digit" });
  if (dk.slice(0, 4) === nk.slice(0, 4)) return d.toLocaleDateString("zh-CN", { timeZone: DISPLAY_TZ, month: "numeric", day: "numeric" });
  return d.toLocaleDateString("zh-CN", { timeZone: DISPLAY_TZ, year: "numeric", month: "numeric", day: "numeric" });
}

export function formatFullDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { timeZone: DISPLAY_TZ, dateStyle: "medium", timeStyle: "short" });
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function addressDisplayName(a: EmailAddress | undefined): string {
  if (!a) return "";
  return a.name?.trim() || a.address;
}

export function formatAddressList(list: EmailAddress[] | undefined): string {
  if (!list || list.length === 0) return "";
  return list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
}

export function initialsOf(a: EmailAddress | undefined): string {
  const name = addressDisplayName(a);
  if (!name) return "?";
  const trimmed = name.replace(/["'<>]/g, "").trim();
  const first = trimmed[0] ?? "?";
  return first.toUpperCase();
}

/** 稳定的头像颜色（按字符串哈希）。 */
export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 55% 45%)`;
}
