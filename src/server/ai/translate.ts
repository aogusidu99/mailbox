import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailAccounts, messageTranslations, messages, type Message } from "@/db/schema";
import { stripHtml } from "@/lib/quote";
import { runRole } from "./client";
import { languageName, translateSchema, translateSystem } from "./prompts";
import { loadAiSettings } from "./settings";

/**
 * 邮件翻译：把主题与正文翻译成目标语言（中/英/德或用户在设置里加的语言），
 * 结果按 (messageId, lang) 缓存到 message_translations，避免重复付费。
 */

const MAX_BODY = 8000;

export interface TranslationResult {
  lang: string;
  subject: string | null;
  body: string;
  model: string | null;
  cached: boolean;
}

/** 校验邮件属于该用户，并确保正文已拉取 */
async function loadOwned(userId: string, messageId: string): Promise<Message> {
  const db = await getDb();
  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message) throw new Error("邮件不存在");
  const account = await db.query.mailAccounts.findFirst({
    where: and(eq(mailAccounts.id, message.accountId), eq(mailAccounts.userId, userId)),
  });
  if (!account) throw new Error("邮件不存在");
  if (!message.bodyFetchedAt) {
    const { ensureMessageBody } = await import("@/server/sync/engine");
    return (await ensureMessageBody(messageId)) ?? message;
  }
  return message;
}

export async function translateMessage(
  userId: string,
  messageId: string,
  lang: string,
  opts: { refresh?: boolean } = {},
): Promise<TranslationResult> {
  const settings = await loadAiSettings(userId);
  const allowed = settings.data.translationLangs.map((l) => l.code);
  if (!allowed.includes(lang)) throw new Error("未配置的翻译语言，请到「AI 设置」添加");

  const db = await getDb();
  const message = await loadOwned(userId, messageId);

  if (!opts.refresh) {
    const cached = await db.query.messageTranslations.findFirst({
      where: and(eq(messageTranslations.messageId, messageId), eq(messageTranslations.lang, lang)),
    });
    if (cached) return { lang, subject: cached.subject, body: cached.body, model: cached.model, cached: true };
  }

  const source = (message.textBody?.trim() || (message.htmlBody ? stripHtml(message.htmlBody, MAX_BODY * 2) : "") || message.snippet || "").slice(0, MAX_BODY);
  if (!source && !message.subject) throw new Error("这封邮件没有可翻译的内容");

  const r = await runRole({
    userId,
    accountId: message.accountId,
    role: "translate",
    settings,
    maxTokens: 8192,
    schema: translateSchema,
    schemaName: "translation",
    messages: [
      { role: "system", content: translateSystem(languageName(lang)) },
      { role: "user", content: `主题：${message.subject ?? "(无主题)"}\n\n正文：\n${source || "(无正文)"}` },
    ],
  });

  const json = r.json as { subject?: string; body?: string } | undefined;
  const subject = (json?.subject ?? "").trim() || message.subject;
  const body = (json?.body ?? r.text ?? "").trim();
  if (!body) throw new Error("翻译失败：模型没有返回正文");

  await db
    .insert(messageTranslations)
    .values({ messageId, lang, subject, body, model: r.model })
    .onConflictDoUpdate({
      target: [messageTranslations.messageId, messageTranslations.lang],
      set: { subject, body, model: r.model, createdAt: new Date() },
    });

  return { lang, subject, body, model: r.model, cached: false };
}
