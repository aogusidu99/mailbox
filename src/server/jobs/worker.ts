import type { PgBoss } from "pg-boss";
import { getDb } from "@/db";
import { mailAccounts } from "@/db/schema";
import { ne } from "drizzle-orm";
import { getBoss } from "./boss";
import { enqueue, enqueueSyncAccount, QUEUES, type JobPayloads, type QueueName } from "./queues";

/**
 * 后台 worker（与 Web 同进程，由 src/instrumentation.ts 在服务启动时拉起）。
 *
 * 队列：
 * - sync:account   整账号同步（定时每 5 分钟 + 新账号 + 手动）
 * - sync:folder    单文件夹同步（IDLE 通知 / 操作回放后）
 * - bodies:fetch   分批拉取正文
 * - outbox:apply   把本地操作回放到服务器（M2）
 * - ai:triage      AI 分类 / 摘要（M3）
 * - ai:embed       向量化（M4）
 */

export interface WorkerStatus {
  started: boolean;
  startedAt?: string;
  lastHeartbeatAt?: string;
  jobsProcessed: number;
  lastError?: string;
  queues: Record<string, { processed: number; failed: number; lastError?: string }>;
  idle: Array<{ accountId: string; email: string; connected: boolean; attempts: number; lastError?: string }>;
}

interface WorkerState {
  status: Omit<WorkerStatus, "idle">;
  boss?: PgBoss;
  timers: NodeJS.Timeout[];
  starting?: Promise<void>;
}

const HEARTBEAT_INTERVAL_MS = 60_000;
const ACCOUNT_SYNC_INTERVAL_MS = 5 * 60_000;
const IDLE_RECONCILE_INTERVAL_MS = 60_000;

const globalRef = globalThis as unknown as { __mailboxWorker?: WorkerState };

function state(): WorkerState {
  if (!globalRef.__mailboxWorker) {
    globalRef.__mailboxWorker = { status: { started: false, jobsProcessed: 0, queues: {} }, timers: [] };
  }
  return globalRef.__mailboxWorker;
}

export async function getWorkerStatus(): Promise<WorkerStatus> {
  const { getIdleManager } = await import("@/server/sync/idle-manager");
  return { ...state().status, idle: getIdleManager().status() };
}

function queueStat(name: string) {
  const s = state().status;
  if (!s.queues[name]) s.queues[name] = { processed: 0, failed: 0 };
  return s.queues[name];
}

async function register<Q extends QueueName>(boss: PgBoss, queue: Q, handler: (data: JobPayloads[Q]) => Promise<void>, pollingIntervalSeconds = 2) {
  await boss.createQueue(queue);
  await boss.work<JobPayloads[Q]>(queue, { pollingIntervalSeconds, batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const stat = queueStat(queue);
      try {
        await handler(job.data);
        stat.processed += 1;
        state().status.jobsProcessed += 1;
      } catch (err) {
        stat.failed += 1;
        stat.lastError = err instanceof Error ? err.message : String(err);
        state().status.lastError = `${queue}: ${stat.lastError}`;
        console.error(`[jobs] ${queue} 失败:`, stat.lastError);
        throw err;
      }
    }
  });
}

async function scheduleAllAccounts(reason: string) {
  const db = await getDb();
  const accounts = await db.query.mailAccounts.findMany({ where: ne(mailAccounts.syncStatus, "disabled") });
  for (const a of accounts) {
    await enqueueSyncAccount(a.id, reason).catch((err) => console.warn("[jobs] 入队同步失败:", err));
  }
}

/** 启动 worker（幂等）。 */
export function startWorker(): Promise<void> {
  const s = state();
  if (s.status.started) return Promise.resolve();
  if (s.starting) return s.starting;
  s.starting = (async () => {
    const boss = await getBoss();
    s.boss = boss;

    const sync = await import("@/server/sync/engine");
    const { getIdleManager } = await import("@/server/sync/idle-manager");

    await register(boss, QUEUES.heartbeat, async () => {
      s.status.lastHeartbeatAt = new Date().toISOString();
    });
    await register(boss, QUEUES.syncAccount, async ({ accountId, reason }) => {
      await sync.syncAccount(accountId, reason);
    });
    await register(boss, QUEUES.syncFolder, async ({ accountId, folderId, folderPath }) => {
      await sync.syncFolderById(accountId, { folderId, folderPath });
    }, 1);
    await register(boss, QUEUES.fetchBodies, async ({ accountId, folderId }) => {
      await sync.fetchPendingBodies(accountId, folderId);
    }, 1);
    await register(boss, QUEUES.outboxApply, async ({ accountId }) => {
      const { applyOutbox } = await import("@/server/sync/outbox");
      await applyOutbox(accountId);
    }, 1);
    await register(boss, QUEUES.aiTriage, async ({ accountId, messageId }) => {
      const { triageMessage } = await import("@/server/ai/triage");
      await triageMessage(accountId, messageId);
    });
    await register(boss, QUEUES.aiEmbed, async ({ accountId, messageId }) => {
      const { embedMessage } = await import("@/server/ai/embeddings");
      await embedMessage(accountId, messageId);
    });

    const tick = (fn: () => Promise<void>, interval: number, runNow: boolean) => {
      const run = () =>
        fn().catch((err) => {
          s.status.lastError = err instanceof Error ? err.message : String(err);
          console.error("[jobs] 定时任务失败:", err);
        });
      if (runNow) void run();
      const t = setInterval(run, interval);
      t.unref?.();
      s.timers.push(t);
    };

    tick(() => enqueue(QUEUES.heartbeat, { at: Date.now() }, { singletonKey: "heartbeat" }).then(() => undefined), HEARTBEAT_INTERVAL_MS, true);
    tick(() => scheduleAllAccounts("scheduled"), ACCOUNT_SYNC_INTERVAL_MS, true);
    tick(() => getIdleManager().reconcile(), IDLE_RECONCILE_INTERVAL_MS, true);

    s.status.started = true;
    s.status.startedAt = new Date().toISOString();
    console.log("[jobs] worker 已启动");
  })().finally(() => {
    s.starting = undefined;
  });
  return s.starting;
}

/** 停止 worker（进程退出时调用）。 */
export async function stopWorker(): Promise<void> {
  const s = state();
  for (const t of s.timers) clearInterval(t);
  s.timers = [];
  try {
    const { getIdleManager } = await import("@/server/sync/idle-manager");
    await getIdleManager().stopAll();
  } catch {
    /* ignore */
  }
  if (s.boss) await s.boss.stop({ graceful: true, timeout: 5000 });
  s.status.started = false;
}
