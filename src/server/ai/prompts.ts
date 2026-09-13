import { z } from "zod";
import type { Message } from "@/db/schema";
import { stripHtml } from "@/lib/quote";

/**
 * 提示词与输出 schema（集中管理，方便版本化）。
 */

export const PROMPT_VERSION = "2026-09-13.1";

export const CATEGORIES = ["important", "todo", "notification", "billing", "newsletter", "promotion", "social", "personal", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  important: "重要",
  todo: "待办",
  notification: "通知",
  billing: "账单",
  newsletter: "订阅",
  promotion: "推广",
  social: "社交",
  personal: "私人",
  other: "其他",
};

/** Gmail 标签名用 ASCII，避免 IMAP 修改版 UTF-7 编码问题 */
export const CATEGORY_LABEL_NAMES: Record<Category, string> = {
  important: "AI/Important",
  todo: "AI/Todo",
  notification: "AI/Notification",
  billing: "AI/Billing",
  newsletter: "AI/Newsletter",
  promotion: "AI/Promotion",
  social: "AI/Social",
  personal: "AI/Personal",
  other: "AI/Other",
};

export const triageSchema = z.object({
  category: z.enum(CATEGORIES),
  priority: z.enum(["high", "normal", "low"]),
  needsReply: z.boolean(),
  summary: z.string().max(200),
  actionItems: z
    .array(
      z.object({
        title: z.string().max(120),
        dueAt: z.string().max(40).nullable(),
      }),
    )
    .max(8),
  reason: z.string().max(200),
});
export type TriageOutput = z.infer<typeof triageSchema>;

export const TRIAGE_SYSTEM = `你是一名细心的邮件助理，帮用户对收到的邮件做分类与摘要。只根据邮件内容判断，不要臆造。

分类标准（category）：
- important：需要用户本人处理或知晓的重要事务（老板/客户/家人来信、合同、面试、账户安全告警等）
- todo：明确要求用户做某件事或回复的邮件
- notification：系统自动通知（验证码、登录提醒、发货/物流、日历提醒、自动回复）
- billing：账单、发票、付款、订单、报销
- newsletter：订阅的资讯、周报、博客更新
- promotion：营销、促销、广告
- social：社交平台通知、群组消息
- personal：朋友/家人的私人信件
- other：以上都不合适

priority：high（今天必须处理）/ normal / low（可忽略）。needsReply：用户是否需要回复。
summary：用中文写一句不超过 40 字的摘要，直接说结论（如「快递已发出，预计周四送达」）。
actionItems：明确的待办事项（标题 + 截止时间，没有截止时间填 null），没有则空数组。
reason：一句话说明分类理由。`;

export function messageToPromptText(m: Pick<Message, "subject" | "fromAddrs" | "toAddrs" | "ccAddrs" | "date" | "textBody" | "htmlBody" | "snippet">, maxChars = 6000): string {
  const fmt = (list: Array<{ name?: string; address: string }>) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
  const body = (m.textBody?.trim() || (m.htmlBody ? stripHtml(m.htmlBody, maxChars * 2) : "") || m.snippet || "").slice(0, maxChars);
  return [
    `发件人：${fmt(m.fromAddrs)}`,
    `收件人：${fmt(m.toAddrs)}`,
    m.ccAddrs.length ? `抄送：${fmt(m.ccAddrs)}` : null,
    `日期：${m.date ? new Date(m.date).toLocaleString("zh-CN") : "未知"}`,
    `主题：${m.subject ?? "(无主题)"}`,
    "",
    "正文：",
    body || "(无正文)",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export const DRAFT_SYSTEM = `你是用户的邮件写作助手。根据原邮件和用户的要求，代用户起草一封回复。
要求：
- 使用与原邮件相同的语言（中文邮件用中文，英文邮件用英文）；
- 语气自然、简洁、礼貌，符合职场邮件习惯；
- 只输出邮件正文（可含称呼与落款占位「[你的名字]」），不要输出主题，不要加解释；
- 不要编造原邮件里没有的事实；需要用户补充的信息用【】标出。`;

export const SUMMARY_SYSTEM = `你是用户的邮件助理，请用中文写清晰、简洁的摘要。`;

export const DIGEST_SYSTEM = `你是用户的邮件助理。根据当天收到的邮件清单（含 AI 分类与摘要），写一份中文「今日邮件摘要」：
1. 先用 2–3 句概括今天邮件的整体情况；
2. 「需要处理」：列出高优先级 / 需回复 / 有待办的邮件，每条一行：发件人 — 要做什么（截止时间）；
3. 「值得一看」：重要但不紧急的；
4. 「可以忽略」：推广、订阅、通知类，只给数量与一两句说明。
用 Markdown 无序列表，不要编造清单里没有的内容。`;
