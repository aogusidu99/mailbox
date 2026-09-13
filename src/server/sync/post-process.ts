import type { Folder, MailAccount } from "@/db/schema";
import { enqueueAiEmbed, enqueueAiTriage } from "@/server/jobs/queues";

/**
 * 正文拉取完成后的后续处理：
 * - 账号开启 AI：入队 triage（分类完成后再跑规则，规则可以引用 AI 字段）；
 * - 未开启 AI：直接跑规则（只匹配非 AI 字段）；
 * - 配置了 embedding 模型：入队向量化。
 */
export async function afterBodyFetched(account: MailAccount, folder: Folder, messageId: string): Promise<void> {
  const inbox = folder.role === "inbox";
  if (account.aiEnabled && inbox) {
    await enqueueAiTriage(account.id, messageId);
  } else if (inbox) {
    const { applyRulesToMessage } = await import("@/server/ai/rules");
    await applyRulesToMessage(account.id, messageId).catch((err) => console.warn("[rules] 执行失败:", err instanceof Error ? err.message : err));
  }
  try {
    const { loadAiSettings } = await import("@/server/ai/settings");
    const { embeddingConfigured } = await import("@/server/ai/embeddings");
    const settings = await loadAiSettings(account.userId);
    if (embeddingConfigured(settings)) await enqueueAiEmbed(account.id, messageId);
  } catch (err) {
    console.warn("[embed] 入队失败:", err instanceof Error ? err.message : err);
  }
}
