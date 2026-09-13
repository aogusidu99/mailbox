import type { EmailAddress } from "@/db/schema";

/**
 * 回复 / 转发的纯文本引用与主题处理（前后端共用，无服务端依赖）。
 */

export function stripHtml(html: string, max = 20_000): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

export function formatAddr(a: EmailAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export function formatAddrList(list: EmailAddress[] | undefined): string {
  return (list ?? []).map(formatAddr).join(", ");
}

export function quoteText(opts: { from: EmailAddress[]; date: string | null; text: string | null; html: string | null }): string {
  const source = opts.text?.trim() || (opts.html ? stripHtml(opts.html) : "");
  const who = opts.from[0] ? formatAddr(opts.from[0]) : "";
  const when = opts.date ? new Date(opts.date).toLocaleString("zh-CN") : "";
  const quoted = source
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\n在 ${when}，${who} 写道：\n${quoted}`;
}

export function replySubject(subject: string | null): string {
  const s = (subject ?? "").trim();
  return /^(re|回复)[:：]/i.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(subject: string | null): string {
  const s = (subject ?? "").trim();
  return /^(fw|fwd|转发)[:：]/i.test(s) ? s : `Fwd: ${s}`;
}

/** 转发时放在正文开头的原邮件信息块。 */
export function forwardHeader(opts: { from: EmailAddress[]; to: EmailAddress[]; date: string | null; subject: string | null }): string {
  return [
    "",
    "",
    "---------- 转发的邮件 ----------",
    `发件人：${formatAddrList(opts.from)}`,
    `日期：${opts.date ? new Date(opts.date).toLocaleString("zh-CN") : ""}`,
    `主题：${opts.subject ?? ""}`,
    `收件人：${formatAddrList(opts.to)}`,
    "",
  ].join("\n");
}

/** 「全部回复」的收件人：原发件人（优先 Reply-To）+ 原收件人/抄送，去掉自己。 */
export function replyAllRecipients(opts: {
  from: EmailAddress[];
  replyTo: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  self: string;
}): { to: EmailAddress[]; cc: EmailAddress[] } {
  const self = opts.self.toLowerCase();
  const primary = (opts.replyTo.length ? opts.replyTo : opts.from).filter((a) => a.address.toLowerCase() !== self);
  const seen = new Set(primary.map((a) => a.address.toLowerCase()));
  const rest = [...opts.to, ...opts.cc].filter((a) => {
    const key = a.address.toLowerCase();
    if (key === self || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { to: primary.length ? primary : opts.from, cc: rest };
}
