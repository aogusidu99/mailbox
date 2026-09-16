import type { Message } from "@/db/schema";
import { formatAddr } from "@/lib/quote";
import { sanitizeEmailHtml, textToHtml } from "./html";

/**
 * 回复 / 转发的 HTML 引用块：把**原邮件的富 HTML**（表格 / 颜色 / 图片等）整块包进 `<blockquote>`，
 * 像 Gmail 那样原样保留层级与格式；原邮件只有纯文本时退化为 textToHtml。
 * 仅服务端使用（依赖 sanitize-html）。
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const QUOTE_STYLE = "margin:0 0 0 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex";

/** 原邮件正文的 HTML：优先富 HTML（清洗但保留排版/图片/表格），否则纯文本转 HTML。 */
function originalInnerHtml(m: Message): string {
  if (m.htmlBody && m.htmlBody.trim()) return sanitizeEmailHtml(m.htmlBody, { allowRemoteImages: true }).html;
  return textToHtml(m.textBody ?? "");
}

/** 回复引用块：`在 X，Y 写道：` + <blockquote>原邮件富 HTML</blockquote> */
export function htmlReplyQuote(m: Message): string {
  const who = m.fromAddrs[0] ? formatAddr(m.fromAddrs[0]) : "";
  const when = m.date ? new Date(m.date).toLocaleString("zh-CN") : "";
  return `<br><div class="gmail_quote"><div>在 ${esc(when)}，${esc(who)} 写道：</div><blockquote class="gmail_quote" style="${QUOTE_STYLE}">${originalInnerHtml(m)}</blockquote></div>`;
}

/** 转发引用块：转发信息头 + <blockquote>原邮件富 HTML</blockquote> */
export function htmlForwardQuote(m: Message): string {
  const head = [
    "---------- 转发的邮件 ----------",
    `发件人：${esc(m.fromAddrs.map(formatAddr).join(", "))}`,
    `日期：${esc(m.date ? new Date(m.date).toLocaleString("zh-CN") : "")}`,
    `主题：${esc(m.subject ?? "")}`,
    `收件人：${esc(m.toAddrs.map(formatAddr).join(", "))}`,
  ].join("<br>");
  return `<br><div class="gmail_quote"><div>${head}</div><blockquote class="gmail_quote" style="${QUOTE_STYLE}">${originalInnerHtml(m)}</blockquote></div>`;
}
