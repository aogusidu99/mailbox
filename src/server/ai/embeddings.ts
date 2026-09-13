import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, mailAccounts, messageEmbeddings, messages } from "@/db/schema";
import { stripHtml } from "@/lib/quote";
import { enqueueAiEmbed } from "@/server/jobs/queues";
import { recordUsage } from "./client";
import { loadAiSettings, resolveRole, type LoadedAiSettings } from "./settings";

/**
 * 语义搜索：把邮件（主题 + 正文前 4000 字）向量化后存库；查询时向量化问题，在应用内做余弦相似度排序。
 * PGlite 没有 pgvector，向量以 JSON 数组存储；个人邮箱规模（几千封）下内存排序足够快。
 */

const MAX_CANDIDATES = 6000;

export function embeddingConfigured(settings: LoadedAiSettings): boolean {
  const cfg = settings.data.roles.embedding;
  return Boolean(cfg?.model && (cfg.provider ?? settings.data.defaultProvider) && settings.keys[cfg.provider ?? settings.data.defaultProvider]);
}

function embeddingText(subject: string | null, textBody: string | null, htmlBody: string | null, snippet: string | null): string {
  const body = textBody?.trim() || (htmlBody ? stripHtml(htmlBody, 8000) : "") || snippet || "";
  return `${subject ?? ""}\n${body}`.slice(0, 4000);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 向量化一封邮件（worker 任务） */
export async function embedMessage(accountId: string, messageId: string): Promise<boolean> {
  const db = await getDb();
  const account = await db.query.mailAccounts.findFirst({ where: eq(mailAccounts.id, accountId) });
  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!account || !message) return false;
  const settings = await loadAiSettings(account.userId);
  if (!embeddingConfigured(settings)) return false;
  const resolved = resolveRole(settings, "embedding");
  if (!resolved.provider.embed) throw new Error(`${resolved.provider.name} 不支持 embedding`);
  const text = embeddingText(message.subject, message.textBody, message.htmlBody, message.snippet);
  if (!text.trim()) return false;
  const r = await resolved.provider.embed({ model: resolved.model, apiKey: resolved.apiKey, baseUrl: resolved.provider.baseUrl, texts: [text] });
  const vector = r.vectors[0];
  if (!vector) return false;
  await db
    .insert(messageEmbeddings)
    .values({ messageId, accountId, chunkIndex: 0, model: r.model, dims: vector.length, vector, text: text.slice(0, 500) })
    .onConflictDoUpdate({ target: [messageEmbeddings.messageId, messageEmbeddings.chunkIndex], set: { model: r.model, dims: vector.length, vector, text: text.slice(0, 500), createdAt: new Date() } });
  await recordUsage({ userId: account.userId, accountId, role: "embedding", providerId: resolved.providerId, model: r.model, usage: r.usage });
  return true;
}

export interface SemanticHit {
  messageId: string;
  accountId: string;
  folderId: string;
  folderName: string;
  subject: string | null;
  from: string;
  date: string | null;
  snippet: string | null;
  score: number;
}

/** 语义搜索（跨该用户全部账号，或限定一个账号） */
export async function semanticSearch(userId: string, query: string, opts: { accountId?: string | null; limit?: number } = {}): Promise<SemanticHit[]> {
  const db = await getDb();
  const settings = await loadAiSettings(userId);
  if (!embeddingConfigured(settings)) throw new Error("还没有配置 embedding 模型，请到「AI 设置」为「语义搜索向量」等级选择模型。");
  const resolved = resolveRole(settings, "embedding");
  if (!resolved.provider.embed) throw new Error(`${resolved.provider.name} 不支持 embedding`);
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  const accountIds = accounts.filter((a) => !opts.accountId || a.id === opts.accountId).map((a) => a.id);
  if (accountIds.length === 0) return [];

  const q = await resolved.provider.embed({ model: resolved.model, apiKey: resolved.apiKey, baseUrl: resolved.provider.baseUrl, texts: [query] });
  await recordUsage({ userId, role: "embedding", providerId: resolved.providerId, model: q.model, usage: q.usage });
  const qv = q.vectors[0];

  const rows = await db
    .select({ messageId: messageEmbeddings.messageId, vector: messageEmbeddings.vector })
    .from(messageEmbeddings)
    .where(inArray(messageEmbeddings.accountId, accountIds))
    .orderBy(desc(messageEmbeddings.createdAt))
    .limit(MAX_CANDIDATES);
  const scored = rows
    .map((r) => ({ messageId: r.messageId, score: cosine(qv, r.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 20);
  if (scored.length === 0) return [];

  const msgs = await db
    .select({ message: messages, folderName: folders.name })
    .from(messages)
    .innerJoin(folders, eq(folders.id, messages.folderId))
    .where(inArray(messages.id, scored.map((s) => s.messageId)));
  const byId = new Map(msgs.map((m) => [m.message.id, m]));
  return scored
    .map((s) => {
      const hit = byId.get(s.messageId);
      if (!hit) return null;
      const m = hit.message;
      return {
        messageId: m.id,
        accountId: m.accountId,
        folderId: m.folderId,
        folderName: hit.folderName,
        subject: m.subject,
        from: m.fromAddrs[0] ? m.fromAddrs[0].name || m.fromAddrs[0].address : "",
        date: m.date ? m.date.toISOString() : null,
        snippet: m.snippet,
        score: Math.round(s.score * 1000) / 1000,
      } satisfies SemanticHit;
    })
    .filter((x): x is SemanticHit => x !== null);
}

/** 回填：给最近 limit 封还没有向量的邮件入队 */
export async function backfillEmbeddings(userId: string, limit = 500): Promise<number> {
  const db = await getDb();
  const settings = await loadAiSettings(userId);
  if (!embeddingConfigured(settings)) throw new Error("还没有配置 embedding 模型");
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  let queued = 0;
  for (const account of accounts) {
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .leftJoin(messageEmbeddings, and(eq(messageEmbeddings.messageId, messages.id), eq(messageEmbeddings.chunkIndex, 0)))
      .where(and(eq(messages.accountId, account.id), isNull(messageEmbeddings.id)))
      .orderBy(desc(messages.date))
      .limit(limit);
    for (const r of rows) {
      await enqueueAiEmbed(account.id, r.id);
      queued += 1;
    }
  }
  return queued;
}
