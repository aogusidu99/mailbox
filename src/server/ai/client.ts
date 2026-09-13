import type { z } from "zod";
import { getDb } from "@/db";
import { aiUsage, type AiRole } from "@/db/schema";
import { estimateCostUsd } from "./pricing";
import { AiProviderError, type AiMessage, type AiUsage, type GenerateResult } from "./providers/types";
import { loadAiSettings, resolveRole, type LoadedAiSettings } from "./settings";

/**
 * 统一入口：按任务等级选模型 → 调用 → 失败时在同厂商候选池内降级 → 记录用量与成本。
 */

export interface RunRoleOptions {
  userId: string;
  role: AiRole;
  messages: AiMessage[];
  schema?: z.ZodType;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
  accountId?: string | null;
  /** 已加载的设置（批量调用时复用） */
  settings?: LoadedAiSettings;
  signal?: AbortSignal;
}

export interface RunRoleResult<T = unknown> extends GenerateResult {
  json?: T;
  providerId: string;
  fallbackFrom?: string;
  costUsd: number;
}

export async function recordUsage(entry: {
  userId: string;
  accountId?: string | null;
  role: AiRole;
  providerId: string;
  model: string;
  usage: AiUsage;
  fallbackFrom?: string;
}): Promise<number> {
  const db = await getDb();
  const costUsd = estimateCostUsd(entry.model, entry.usage);
  await db.insert(aiUsage).values({
    userId: entry.userId,
    accountId: entry.accountId ?? null,
    feature: entry.role,
    provider: entry.providerId,
    model: entry.model,
    fallbackFrom: entry.fallbackFrom ?? null,
    inputTokens: entry.usage.inputTokens,
    outputTokens: entry.usage.outputTokens,
    cacheReadTokens: entry.usage.cacheReadTokens,
    cacheWriteTokens: entry.usage.cacheWriteTokens,
    costUsd,
  });
  return costUsd;
}

export async function runRole<T = unknown>(opts: RunRoleOptions): Promise<RunRoleResult<T>> {
  const settings = opts.settings ?? (await loadAiSettings(opts.userId));
  const resolved = resolveRole(settings, opts.role);
  const attempts = [resolved.model, ...resolved.fallbackModels];
  let lastError: unknown;

  for (let i = 0; i < attempts.length; i++) {
    const model = attempts[i];
    try {
      const result = await resolved.provider.generate({
        model,
        apiKey: resolved.apiKey,
        baseUrl: resolved.provider.baseUrl,
        messages: opts.messages,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        effort: resolved.effort,
        schema: opts.schema,
        schemaName: opts.schemaName,
        signal: opts.signal,
      });
      const fallbackFrom = i > 0 ? resolved.model : undefined;
      const costUsd = await recordUsage({
        userId: opts.userId,
        accountId: opts.accountId,
        role: opts.role,
        providerId: resolved.providerId,
        model: result.model || model,
        usage: result.usage,
        fallbackFrom,
      });
      if (fallbackFrom) console.warn(`[ai] ${opts.role}: ${fallbackFrom} 失败，已降级到 ${model}`);
      return { ...result, json: result.json as T, providerId: resolved.providerId, fallbackFrom, costUsd };
    } catch (err) {
      lastError = err;
      const retryable = err instanceof AiProviderError ? err.retryableWithFallback : true;
      if (!retryable || i === attempts.length - 1) break;
      console.warn(`[ai] ${opts.role}: 模型 ${model} 失败（${err instanceof Error ? err.message : String(err)}），尝试备用模型…`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 检测某厂商 Key / 模型是否可用（设置页「测试连接」） */
export async function testProvider(settings: LoadedAiSettings, providerId: string, model: string): Promise<{ ok: true; reply: string; model: string } | { ok: false; error: string }> {
  const { getProviderAdapter } = await import("./settings");
  const provider = getProviderAdapter(settings.data, providerId);
  if (!provider) return { ok: false, error: "未知厂商" };
  const apiKey = settings.keys[providerId];
  if (!apiKey) return { ok: false, error: "还没有填写 API Key" };
  try {
    const r = await provider.generate({
      model,
      apiKey,
      baseUrl: provider.baseUrl,
      messages: [{ role: "user", content: "请只回复：ok" }],
      maxTokens: 64,
      effort: "low",
    });
    return { ok: true, reply: r.text.trim().slice(0, 40), model: r.model };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
