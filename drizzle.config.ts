import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit 配置：
 * - `bun run db:generate` 根据 src/db/schema.ts 生成 SQL 迁移到 ./drizzle
 * - 应用启动时由 src/db/index.ts 自动应用迁移（PGlite 与 PostgreSQL 通用）
 * - 有 DATABASE_URL 时指向真实 PostgreSQL，否则指向 PGlite 数据目录（供 studio/push 使用）
 */
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig(
  databaseUrl
    ? {
        dialect: "postgresql",
        schema: "./src/db/schema.ts",
        out: "./drizzle",
        dbCredentials: { url: databaseUrl },
      }
    : {
        dialect: "postgresql",
        driver: "pglite",
        schema: "./src/db/schema.ts",
        out: "./drizzle",
        dbCredentials: { url: process.env.PGLITE_DATA_DIR ?? "./data/pglite" },
      },
);
