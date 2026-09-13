/**
 * 数据库备份：bun run db:backup
 * - PostgreSQL（有 DATABASE_URL）：优先调用 pg_dump 生成 SQL；没有 pg_dump 时导出各表为 JSON。
 * - PGlite（默认）：用 dumpDataDir 打包数据目录为 .tar.gz。注意：PGlite 单进程独占，请先停止应用再备份。
 * 输出到 data/backups/。恢复方法见 README。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outDir = path.resolve(process.cwd(), "data", "backups");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

async function backupPostgres(url: string) {
  const sqlFile = path.join(outDir, `pg-${stamp}.sql`);
  const dump = spawnSync("pg_dump", ["--no-owner", "--no-privileges", "-f", sqlFile, url], { stdio: "inherit" });
  if (dump.status === 0) {
    console.log(`已用 pg_dump 备份到 ${sqlFile}`);
    return;
  }
  console.warn("pg_dump 不可用，改为导出 JSON（可用 scripts/restore-json.ts 思路手动导回）");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url });
  const tables = (await pool.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' order by tablename")).rows.map((r) => r.tablename);
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = (await pool.query(`select * from "${t}"`)).rows;
  await pool.end();
  const file = path.join(outDir, `pg-${stamp}.json`);
  writeFileSync(file, JSON.stringify(out));
  console.log(`已导出 ${tables.length} 张表到 ${file}`);
}

async function backupPglite(dir: string) {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(dir);
  await pg.waitReady;
  const blob = await pg.dumpDataDir("gzip");
  await pg.close();
  const file = path.join(outDir, `pglite-${stamp}.tar.gz`);
  writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  console.log(`已备份 PGlite 数据目录到 ${file}`);
}

const url = process.env.DATABASE_URL;
if (url) await backupPostgres(url);
else await backupPglite(path.resolve(process.cwd(), process.env.PGLITE_DATA_DIR ?? "./data/pglite"));
