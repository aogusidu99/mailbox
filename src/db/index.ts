import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { getEnv } from "@/env";
import * as schema from "./schema";

/**
 * 数据库连接层：
 * - 有 DATABASE_URL → PostgreSQL（node-postgres 连接池）
 * - 否则 → PGlite（嵌入式 Postgres，数据在 PGLITE_DATA_DIR）
 *
 * 两者共用同一套 Drizzle schema 和 ./drizzle 下的 SQL 迁移，启动时自动应用迁移。
 * 业务代码只依赖 `Db` 类型，不感知底层驱动。
 */

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DbHandle =
  | { kind: "pglite"; db: Db; client: PGlite; close(): Promise<void> }
  | { kind: "postgres"; db: Db; pool: Pool; close(): Promise<void> };

export interface CreateDbOptions {
  /** PostgreSQL 连接串；为空则用 PGlite */
  databaseUrl?: string;
  /** PGlite 数据目录；传 null 表示纯内存（测试用） */
  pgliteDataDir?: string | null;
  /** 迁移目录，默认 <cwd>/drizzle */
  migrationsFolder?: string;
}

export async function createDbHandle(opts: CreateDbOptions = {}): Promise<DbHandle> {
  const migrationsFolder = opts.migrationsFolder ?? path.resolve(process.cwd(), "drizzle");

  if (opts.databaseUrl) {
    const pool = new Pool({ connectionString: opts.databaseUrl });
    const db = drizzlePg({ client: pool, schema });
    await migratePg(db, { migrationsFolder });
    return { kind: "postgres", db, pool, close: () => pool.end() };
  }

  let client: PGlite;
  if (opts.pgliteDataDir) {
    // turbopackIgnore：数据目录来自环境变量，避免 Next 构建时把整个项目纳入文件追踪
    mkdirSync(/*turbopackIgnore: true*/ opts.pgliteDataDir, { recursive: true });
    client = new PGlite(opts.pgliteDataDir);
  } else {
    client = new PGlite();
  }
  try {
    await client.waitReady;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `PGlite 数据库无法打开（${message}）。如果是进程被强制结束导致数据损坏，可把 ${opts.pgliteDataDir ?? "内存库"} 目录改名后重启，应用会重新初始化并重新同步邮件。`,
    );
  }
  const db = drizzlePglite({ client, schema });
  await migratePglite(db, { migrationsFolder });
  return { kind: "pglite", db, client, close: () => client.close() };
}

// 进程级单例（挂在 globalThis 上，避免 Next.js 开发模式热更新时重复创建连接）
const globalRef = globalThis as unknown as { __mailboxDbHandle?: Promise<DbHandle> };

/** 获取（并在首次调用时初始化）全局数据库句柄。 */
export function getDbHandle(): Promise<DbHandle> {
  if (!globalRef.__mailboxDbHandle) {
    const env = getEnv();
    globalRef.__mailboxDbHandle = createDbHandle({
      databaseUrl: env.DATABASE_URL,
      pgliteDataDir: path.resolve(/*turbopackIgnore: true*/ process.cwd(), env.PGLITE_DATA_DIR),
    }).catch((err) => {
      // 初始化失败时清掉缓存，允许下次重试
      globalRef.__mailboxDbHandle = undefined;
      throw err;
    });
  }
  return globalRef.__mailboxDbHandle;
}

/** 获取 Drizzle 数据库实例。 */
export async function getDb(): Promise<Db> {
  return (await getDbHandle()).db;
}

/** 测试用：用指定句柄替换全局单例（传 undefined 清除）。 */
export function setDbHandleForTests(handle: DbHandle | undefined): void {
  globalRef.__mailboxDbHandle = handle ? Promise.resolve(handle) : undefined;
}

export { schema };
