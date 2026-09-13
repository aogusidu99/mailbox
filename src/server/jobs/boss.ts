import type { PGlite } from "@electric-sql/pglite";
import { PgBoss } from "pg-boss";
import { getDbHandle, type DbHandle } from "@/db";

/**
 * pg-boss 任务队列实例。
 *
 * - PostgreSQL：直接用连接串。
 * - PGlite：通过自定义 db 适配器把 SQL 转给 PGlite（无参数的多语句脚本走 exec，
 *   带参数的查询走 query）。PGlite 单连接串行执行，pg-boss 的自定义适配器约定
 *   executeSql 不包裹事务，因此可以安全共用。
 */

export function createPgliteAdapter(client: PGlite) {
  return {
    async executeSql(text: string, values?: unknown[]) {
      if (!values || values.length === 0) {
        const results = await client.exec(text);
        const last = results[results.length - 1];
        return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0 };
      }
      const r = await client.query(text, values as never[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  };
}

export function createBossForHandle(handle: DbHandle, connectionString?: string): PgBoss {
  const common = { schema: "pgboss", supervise: true, schedule: false } as const;
  if (handle.kind === "postgres") {
    return new PgBoss({ ...common, connectionString });
  }
  return new PgBoss({ ...common, db: createPgliteAdapter(handle.client) });
}

const globalRef = globalThis as unknown as { __mailboxBoss?: Promise<PgBoss> };

/** 所有队列名（启动时统一创建，保证 Web 进程也能在 worker 注册前入队）。 */
export const ALL_QUEUES = ["heartbeat", "sync.account", "sync.folder", "bodies.fetch", "outbox.apply", "ai.triage", "ai.embed"] as const;

/** 获取（并在首次调用时启动）全局 pg-boss 实例。 */
export function getBoss(): Promise<PgBoss> {
  if (!globalRef.__mailboxBoss) {
    globalRef.__mailboxBoss = (async () => {
      const handle = await getDbHandle();
      const boss = createBossForHandle(handle, process.env.DATABASE_URL);
      boss.on("error", (err) => console.error("[jobs] pg-boss error:", err));
      await boss.start();
      for (const q of ALL_QUEUES) await boss.createQueue(q);
      return boss;
    })().catch((err) => {
      globalRef.__mailboxBoss = undefined;
      throw err;
    });
  }
  return globalRef.__mailboxBoss;
}

/** 测试用：停止并清除全局实例。 */
export async function stopBossForTests(): Promise<void> {
  const pending = globalRef.__mailboxBoss;
  globalRef.__mailboxBoss = undefined;
  if (!pending) return;
  try {
    const boss = await pending;
    await boss.stop({ graceful: false });
  } catch {
    /* ignore */
  }
}
