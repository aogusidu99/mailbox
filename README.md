# Mailbox

自托管的 AI 邮件处理 Web 应用：多邮箱接入（Gmail / QQ / 163 / 任意 IMAP），AI 自动分类、摘要、智能回复草稿，
所有处理结果同步回邮件服务器。完整方案见 [docs/PLAN.md](docs/PLAN.md)。

## 技术栈

Next.js 16（App Router）· TypeScript · Tailwind CSS + shadcn/ui · Drizzle ORM · PGlite（开发）/ PostgreSQL（生产）·
pg-boss · imapflow / nodemailer · Auth.js · Anthropic SDK（Claude Opus 5）

## 快速开始

```bash
bun install
bun run setup      # 生成 .env.local（随机密钥 + 默认管理员账号）
bun run dev        # http://localhost:3000
```

默认管理员账号 `admin@mailbox.local`，密码在 `.env.local` 的 `ADMIN_PASSWORD` 中。
开发环境无需安装数据库：留空 `DATABASE_URL` 即使用嵌入式 PGlite，数据保存在 `./data/pglite`。

## 常用命令

| 命令 | 说明 |
|---|---|
| `bun run dev` | 启动开发服务器（同进程启动后台 worker） |
| `bun run typecheck` | 生成路由类型并做 TypeScript 检查 |
| `bun test` | 单元测试（含内存 PGlite 上的真实迁移） |
| `bun run lint` | ESLint |
| `bun run db:generate` | 修改 `src/db/schema.ts` 后生成 SQL 迁移（启动时自动应用） |
| `bun run db:studio` | Drizzle Studio 查看数据 |

健康检查：`GET /api/health` 返回数据库类型与 worker 状态。

## 目录

```
src/
├─ app/                 # 页面与路由（login、mail、api/*）
├─ components/ui/       # shadcn/ui 组件
├─ db/                  # Drizzle schema 与连接层（PGlite / PostgreSQL 切换）
├─ server/
│  ├─ auth/             # 密码哈希、管理员种子
│  ├─ crypto/           # 邮箱凭据加密
│  ├─ jobs/             # pg-boss 队列与 worker
│  └─ providers/        # 邮箱提供方接口与预设
├─ auth.ts              # Auth.js 配置
├─ env.ts               # 环境变量校验
└─ instrumentation.ts   # 服务启动引导
drizzle/                # SQL 迁移
tests/                  # bun test
```
