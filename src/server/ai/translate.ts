import { and, eq } from "drizzle-orm";
import { franc } from "franc-min";
import { getDb } from "@/db";
import { mailAccounts, messageTranslations, messages, type Message } from "@/db/schema";
import { stripHtml } from "@/lib/quote";
import { sanitizeEmailHtml, textToHtml } from "@/server/mail/html";
import { runRole } from "./client";
import { segmentHtml, type HtmlSegment } from "./html-segments";
import { languageName, translateSchema, translateSegmentsSchema, translateSegmentsSystem, translateSystem, type TranslateSegmentsOutput } from "./prompts";
import { loadAiSettings, type LoadedAiSettings } from "./settings";

/**
 * 邮件翻译：把主题与正文翻译成目标语言（中/英/德或用户在设置里加的语言），
 * 结果按 (messageId, lang) 缓存到 message_translations，避免重复付费。
 *
 * - HTML 邮件：「保留排版」翻译——只把正文里的文字片段交给模型，标签 / 样式 / 图片 / 链接原样拼回（见 html-segments.ts）；
 * - 纯文本邮件：整段翻译纯文本。
 */

const MAX_BODY = 8000;
/** HTML 邮件最多翻译这么多字符的文字（超出部分保留原文），防止超长营销邮件烧钱 */
const MAX_HTML_SOURCE = 30_000;
/** 每次调用模型最多带多少字符 / 多少段（分批并发，避免单次输出过长被截断） */
const BATCH_CHARS = 4000;
const BATCH_SEGMENTS = 80;
const BATCH_CONCURRENCY = 3;

export interface TranslationResult {
  lang: string;
  subject: string | null;
  body: string;
  /** HTML 邮件的译后 HTML（已清洗、远程图片未屏蔽）；纯文本邮件为 null */
  html: string | null;
  model: string | null;
  cached: boolean;
}

/** 给前端展示的译文：html 一定有值，且已按「是否显示远程图片」重新清洗 */
export type TranslationView = Omit<TranslationResult, "html"> & { html: string };

export function toTranslationView(r: TranslationResult, opts: { allowRemoteImages?: boolean } = {}): TranslationView {
  // 纯文本邮件用与原文相同的渲染（引用竖线、自动链接）
  const html = r.html ? sanitizeEmailHtml(r.html, { allowRemoteImages: opts.allowRemoteImages }).html : textToHtml(r.body);
  return { ...r, html };
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

interface Translated {
  subject: string | null;
  body: string;
  html: string | null;
  model: string;
}

/** 纯文本邮件：整段翻译 */
async function translatePlain(userId: string, message: Message, lang: string, settings: LoadedAiSettings): Promise<Translated> {
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
  return { subject, body, html: null, model: r.model };
}

/** 按字符数 / 段数把片段切成若干批 */
function toBatches(segments: HtmlSegment[]): HtmlSegment[][] {
  const batches: HtmlSegment[][] = [];
  let cur: HtmlSegment[] = [];
  let chars = 0;
  for (const s of segments) {
    if (cur.length && (chars + s.text.length > BATCH_CHARS || cur.length >= BATCH_SEGMENTS)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(s);
    chars += s.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** 有并发上限的 map（保持结果顺序） */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** HTML 邮件：保留排版，只翻译文字片段，再拼回原 HTML */
async function translateHtml(userId: string, message: Message, htmlBody: string, lang: string, settings: LoadedAiSettings): Promise<Translated> {
  // 先按展示用的规则清洗（放行远程图片，展示前会再按用户选择屏蔽），保证拼回的 HTML 结构干净
  const source = sanitizeEmailHtml(htmlBody, { allowRemoteImages: true }).html;
  const seg = segmentHtml(source);

  // 超长邮件只翻译前 MAX_HTML_SOURCE 字符的文字，其余保留原文
  const picked: HtmlSegment[] = [];
  let total = 0;
  for (const s of seg.segments) {
    if (picked.length && total + s.text.length > MAX_HTML_SOURCE) break;
    picked.push(s);
    total += s.text.length;
  }
  if (!picked.length && !message.subject) throw new Error("这封邮件没有可翻译的内容");

  // 第一批顺带翻译主题；正文没有文字（纯图片邮件）时只翻译主题
  const batches = picked.length ? toBatches(picked) : [[]];
  const system = translateSegmentsSystem(languageName(lang));
  const results = await mapLimit(batches, BATCH_CONCURRENCY, (batch, i) =>
    runRole<TranslateSegmentsOutput>({
      userId,
      accountId: message.accountId,
      role: "translate",
      settings,
      maxTokens: 8192,
      schema: translateSegmentsSchema,
      schemaName: "translation_segments",
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify({ subject: i === 0 ? (message.subject ?? "") : "", segments: batch }) },
      ],
    }),
  );

  const wanted = new Set(picked.map((s) => s.id));
  const translations = new Map<number, string>();
  for (const r of results) {
    for (const s of r.json?.segments ?? []) {
      if (wanted.has(s.id) && s.text.trim()) translations.set(s.id, s.text);
    }
  }
  if (picked.length && !translations.size) throw new Error("翻译失败：模型没有返回译文");

  const html = seg.rebuild(translations);
  const subject = (results[0].json?.subject ?? "").trim() || message.subject;
  return { subject, body: stripHtml(html, MAX_HTML_SOURCE * 2), html, model: results[0].model };
}

/** 翻译核心：命中缓存直接返回，否则调模型并写缓存（不校验语言是否在允许列表，供自动翻译复用） */
async function translateCore(userId: string, message: Message, lang: string, settings: LoadedAiSettings, opts: { refresh?: boolean }): Promise<TranslationResult> {
  const db = await getDb();
  if (!opts.refresh) {
    const cached = await db.query.messageTranslations.findFirst({
      where: and(eq(messageTranslations.messageId, message.id), eq(messageTranslations.lang, lang)),
    });
    // 旧版缓存里 HTML 邮件只有纯文本译文（排版丢失）：视为未命中，重新按「保留排版」翻译一次
    if (cached && (cached.html || !message.htmlBody)) {
      return { lang, subject: cached.subject, body: cached.body, html: cached.html, model: cached.model, cached: true };
    }
  }

  const t = message.htmlBody ? await translateHtml(userId, message, message.htmlBody, lang, settings) : await translatePlain(userId, message, lang, settings);

  await db
    .insert(messageTranslations)
    .values({ messageId: message.id, lang, subject: t.subject, body: t.body, html: t.html, model: t.model })
    .onConflictDoUpdate({
      target: [messageTranslations.messageId, messageTranslations.lang],
      set: { subject: t.subject, body: t.body, html: t.html, model: t.model, createdAt: new Date() },
    });

  return { lang, ...t, cached: false };
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
