import { and, eq } from "drizzle-orm";
import { franc } from "franc-min";
import { getDb } from "@/db";
import { mailAccounts, messageTranslations, messages, type Message } from "@/db/schema";
import { stripHtml } from "@/lib/quote";
import { runRole } from "./client";
import { languageName, translateSchema, translateSystem } from "./prompts";
import { loadAiSettings, type LoadedAiSettings } from "./settings";

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

/** 邮件可翻译的纯文本正文（去 HTML、截断） */
function plainSource(message: Message): string {
  return (message.textBody?.trim() || (message.htmlBody ? stripHtml(message.htmlBody, MAX_BODY * 2) : "") || message.snippet || "").slice(0, MAX_BODY);
}

// 自动翻译：franc 返回 ISO 639-3；下列视为「中文 / 英文 / 测不准」，不自动翻译
const SKIP_LANGS = new Set(["eng", "cmn", "und"]);
// ISO 639-3 → 中文名（仅常见语言，用于「已自动从X译为英文」提示；缺失回退为空）
const LANG3_NAMES: Record<string, string> = {
  deu: "德语", fra: "法语", spa: "西班牙语", ita: "意大利语", por: "葡萄牙语", nld: "荷兰语",
  rus: "俄语", jpn: "日语", kor: "韩语", ara: "阿拉伯语", tur: "土耳其语", pol: "波兰语",
  swe: "瑞典语", ukr: "乌克兰语", vie: "越南语", tha: "泰语", ind: "印尼语", ell: "希腊语",
  ces: "捷克语", ron: "罗马尼亚语", hun: "匈牙利语", dan: "丹麦语", fin: "芬兰语", nob: "挪威语", heb: "希伯来语",
};

/** 检测正文语言（离线，ISO 639-3）；文本太短返回 'und' */
function detectLang(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 12) return "und";
  return franc(t.slice(0, 2000), { minLength: 12 });
}

/** 翻译核心：命中缓存直接返回，否则调模型并写缓存（不校验语言是否在允许列表，供自动翻译复用） */
async function translateCore(userId: string, message: Message, lang: string, settings: LoadedAiSettings, opts: { refresh?: boolean }): Promise<TranslationResult> {
  const db = await getDb();
  if (!opts.refresh) {
    const cached = await db.query.messageTranslations.findFirst({
      where: and(eq(messageTranslations.messageId, message.id), eq(messageTranslations.lang, lang)),
    });
    if (cached) return { lang, subject: cached.subject, body: cached.body, model: cached.model, cached: true };
  }

  const source = plainSource(message);
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
    .values({ messageId: message.id, lang, subject, body, model: r.model })
    .onConflictDoUpdate({
      target: [messageTranslations.messageId, messageTranslations.lang],
      set: { subject, body, model: r.model, createdAt: new Date() },
    });

  return { lang, subject, body, model: r.model, cached: false };
}

/** 手动翻译成目标语言（需在「AI 设置」的翻译语言列表里） */
export async function translateMessage(userId: string, messageId: string, lang: string, opts: { refresh?: boolean } = {}): Promise<TranslationResult> {
  const settings = await loadAiSettings(userId);
  const allowed = settings.data.translationLangs.map((l) => l.code);
  if (!allowed.includes(lang)) throw new Error("未配置的翻译语言，请到「AI 设置」添加");
  const message = await loadOwned(userId, messageId);
  return translateCore(userId, message, lang, settings, opts);
}

export interface AutoTranslateResult {
  translated: boolean;
  /** 检测到的源语言（ISO 639-3）；'und' = 测不准 */
  lang: string;
  /** 源语言中文名（已知时） */
  langName: string | null;
  result?: TranslationResult;
}

/**
 * 阅读时自动翻译：若设置开启，且检测到邮件「非中文、非英文」，就翻译成英文。
 * 结果与手动「翻译→英文」共用同一份缓存（messageId, 'en'），只在首次触发时付费。
 */
export async function autoTranslateToEnglish(userId: string, messageId: string): Promise<AutoTranslateResult> {
  const settings = await loadAiSettings(userId);
  if (settings.data.autoTranslateEnglish === false) return { translated: false, lang: "und", langName: null };
  const message = await loadOwned(userId, messageId);
  const iso3 = detectLang(plainSource(message));
  if (SKIP_LANGS.has(iso3)) return { translated: false, lang: iso3, langName: null };
  const result = await translateCore(userId, message, "en", settings, {});
  return { translated: true, lang: iso3, langName: LANG3_NAMES[iso3] ?? null, result };
}
