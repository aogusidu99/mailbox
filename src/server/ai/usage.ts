import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { aiUsage } from "@/db/schema";
import { priceFor } from "./pricing";

export interface UsageRow {
  role: string;
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  priceKnown: boolean;
}

export interface UsageSummary {
  since: string;
  rows: UsageRow[];
  totalCalls: number;
  totalCostUsd: number;
  fallbacks: number;
}

/** 最近 N 天的用量与估算成本（按等级 / 厂商 / 模型分组） */
export async function usageSummary(userId: string, days = 30): Promise<UsageSummary> {
  const db = await getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({
      role: aiUsage.feature,
      provider: aiUsage.provider,
      model: aiUsage.model,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum(${aiUsage.cacheReadTokens}), 0)::int`,
      costUsd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float8`,
      fallbacks: sql<number>`count(${aiUsage.fallbackFrom})::int`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), gte(aiUsage.createdAt, since)))
    .groupBy(aiUsage.feature, aiUsage.provider, aiUsage.model)
    .orderBy(desc(sql`sum(${aiUsage.costUsd})`));
  return {
    since: since.toISOString(),
    rows: rows.map((r) => ({ ...r, priceKnown: priceFor(r.model) !== null })),
    totalCalls: rows.reduce((s, r) => s + r.calls, 0),
    totalCostUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    fallbacks: rows.reduce((s, r) => s + r.fallbacks, 0),
  };
}
