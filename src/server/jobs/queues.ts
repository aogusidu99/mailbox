import { getBoss } from "./boss";

/**
 * 任务队列定义与入队辅助函数。所有 worker 处理器在 worker.ts 注册。
 */

// 注意：pg-boss 队列名只允许字母数字、下划线、连字符、点和斜杠
export const QUEUES = {
  heartbeat: "heartbeat",
  syncAccount: "sync.account",
  syncFolder: "sync.folder",
  fetchBodies: "bodies.fetch",
  outboxApply: "outbox.apply",
  aiTriage: "ai.triage",
  aiEmbed: "ai.embed",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobPayloads {
  [QUEUES.heartbeat]: { at: number };
  [QUEUES.syncAccount]: { accountId: string; reason?: string };
  [QUEUES.syncFolder]: { accountId: string; folderId?: string; folderPath?: string };
  [QUEUES.fetchBodies]: { accountId: string; folderId: string };
  [QUEUES.outboxApply]: { accountId: string };
  [QUEUES.aiTriage]: { accountId: string; messageId: string };
  [QUEUES.aiEmbed]: { accountId: string; messageId: string };
}

export async function enqueue<Q extends QueueName>(
  queue: Q,
  data: JobPayloads[Q],
  options: { singletonKey?: string; startAfter?: number; retryLimit?: number; priority?: number } = {},
): Promise<string | null> {
  const boss = await getBoss();
  // pg-boss 会对存在但为 undefined 的选项做断言，只传有值的键
  const sendOptions: Record<string, unknown> = {
    retryLimit: options.retryLimit ?? 2,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 15 * 60,
  };
  if (options.singletonKey) sendOptions.singletonKey = options.singletonKey;
  if (options.startAfter !== undefined) sendOptions.startAfter = options.startAfter;
  if (options.priority !== undefined) sendOptions.priority = options.priority;
  return boss.send(queue, data, sendOptions);
}

export function enqueueSyncAccount(accountId: string, reason = "manual") {
  return enqueue(QUEUES.syncAccount, { accountId, reason }, { singletonKey: `sync:${accountId}` });
}

export function enqueueSyncFolder(accountId: string, target: { folderId?: string; folderPath?: string }) {
  const key = `sync:${accountId}:${target.folderId ?? target.folderPath ?? "?"}`;
  return enqueue(QUEUES.syncFolder, { accountId, ...target }, { singletonKey: key });
}

export function enqueueFetchBodies(accountId: string, folderId: string) {
  return enqueue(QUEUES.fetchBodies, { accountId, folderId }, { singletonKey: `bodies:${folderId}` });
}

export function enqueueOutboxApply(accountId: string) {
  return enqueue(QUEUES.outboxApply, { accountId }, { singletonKey: `outbox:${accountId}`, priority: 5 });
}

export function enqueueAiTriage(accountId: string, messageId: string) {
  return enqueue(QUEUES.aiTriage, { accountId, messageId }, { singletonKey: `triage:${messageId}` });
}

export function enqueueAiEmbed(accountId: string, messageId: string) {
  return enqueue(QUEUES.aiEmbed, { accountId, messageId }, { singletonKey: `embed:${messageId}` });
}
