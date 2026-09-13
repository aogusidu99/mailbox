import type { EmailAddress } from "@/db/schema";

/** 列表用日期：今天显示时间，今年显示月日，否则显示年月日。 */
export function formatListDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "numeric", day: "numeric" });
}

export function formatFullDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
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
