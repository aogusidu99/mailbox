/**
 * 本地开发一键初始化：生成 .env.local（已存在则跳过，加 --force 覆盖）。
 * 用法：bun run setup [--force]
 *
 * 生成内容：随机 AUTH_SECRET / APP_MASTER_KEY，默认管理员账号与随机密码。
 * 密码只写入 .env.local，不会打印到终端。
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const file = path.resolve(process.cwd(), ".env.local");
const force = process.argv.includes("--force");

if (existsSync(file) && !force) {
  console.log(".env.local 已存在，跳过生成（如需重新生成请加 --force）。");
  process.exit(0);
}

const adminEmail = process.env.ADMIN_EMAIL ?? "admin@mailbox.local";
const adminPassword = process.env.ADMIN_PASSWORD ?? randomBytes(12).toString("base64url");

const content = `# 由 scripts/setup.ts 生成，本文件已被 .gitignore 忽略，请勿提交。

# ---- 应用登录 ----
AUTH_SECRET=${randomBytes(32).toString("base64url")}
ADMIN_EMAIL=${adminEmail}
ADMIN_PASSWORD=${adminPassword}

# ---- 凭据加密主密钥（更换会导致已保存的邮箱凭据无法解密）----
APP_MASTER_KEY=${randomBytes(32).toString("hex")}

# ---- 数据库：留空使用嵌入式 PGlite；生产环境填 PostgreSQL 连接串 ----
# DATABASE_URL=postgres://user:pass@localhost:5432/mailbox
PGLITE_DATA_DIR=./data/pglite

# ---- AI（可选：仅作为首次启动的种子，正式在设置页填写各厂商 Key）----
# ANTHROPIC_API_KEY=sk-ant-...

# ---- 后台 worker ----
WORKER_ENABLED=true
`;

writeFileSync(file, content, { encoding: "utf8" });
console.log(`已生成 ${file}`);
console.log(`管理员账号：${adminEmail}（密码见 .env.local 中的 ADMIN_PASSWORD）`);
