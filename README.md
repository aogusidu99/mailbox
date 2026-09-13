# Mailbox

自托管的 AI 邮件处理 Web 应用：多邮箱接入（Gmail / QQ / 163 / 126 / iCloud / 任意 IMAP，Gmail 与 Outlook 还可 OAuth 授权登录），
AI 自动分类、摘要、待办抽取、回复起草、自然语言规则、语义搜索、「和邮箱对话」，所有处理结果同步回邮件服务器。
完整方案与各里程碑验证记录见 [docs/PLAN.md](docs/PLAN.md)。

## 技术栈

Next.js 16（App Router）· TypeScript · Tailwind CSS + shadcn/ui · Drizzle ORM · PGlite（开发）/ PostgreSQL（生产）·
pg-boss · imapflow / nodemailer · Auth.js · 多厂商 AI 适配层（Anthropic 官方 SDK、OpenAI、Gemini、DeepSeek、任意 OpenAI 兼容端点）

## 快速开始

```bash
bun install
bun run setup      # 生成 .env.local（随机密钥 + 默认管理员账号）
bun run dev        # http://localhost:3000
```

默认管理员账号 `admin@mailbox.local`，密码在 `.env.local` 的 `ADMIN_PASSWORD` 中。
开发环境无需安装数据库：留空 `DATABASE_URL` 即使用嵌入式 PGlite，数据保存在 `./data/pglite`。

### 添加邮箱

「添加邮箱」向导内置 Gmail / QQ / 163 / iCloud 预设，填邮箱地址和**授权码 / 应用专用密码**即可（不是网页登录密码）。
各家授权码的获取步骤见 [docs/PLAN.md 附录 A](docs/PLAN.md#附录-a授权码--应用专用密码怎么拿)。

Gmail / Outlook 也可以走 OAuth：先在「设置 → OAuth 授权登录」填入 Google Cloud / Azure 注册的应用凭据（页面里有分步说明与回调地址），
再点「连接账号」。Google 授权请在系统默认浏览器里完成。

### 配置 AI

「设置 → AI 设置」：为各厂商填 Key（加密存库）→「刷新模型列表」勾选候选池 → 选全局默认模型 → 按任务等级
（分类 / 摘要 / 抽取 / 起草 / 规则 / 对话 / 向量）指定不同厂商与模型，或用「质量优先 / 均衡 / 省钱」一键预设。
在「邮箱管理」里给账号打开「AI 处理」后，新邮件会自动分类并写回 Gmail 标签。

## 常用命令

| 命令 | 说明 |
|---|---|
| `bun run dev` | 启动开发服务器（同进程启动后台 worker） |
| `bun run typecheck` | 生成路由类型并做 TypeScript 检查 |
| `bun test` | 单元 / 集成测试（内存 PGlite、本地假 IMAP 服务器、假 OpenAI 兼容服务） |
| `bun run e2e` | Playwright 端到端测试（驱动本机 Edge，需先 `bun run dev`） |
| `bun run lint` | ESLint |
| `bun run db:generate` | 修改 `src/db/schema.ts` 后生成 SQL 迁移（启动时自动应用） |
| `bun run db:backup` | 备份数据库到 `data/backups/`（PGlite 需先停止应用） |
| `bun run build` | 生产构建 |

健康检查：`GET /api/health` 返回数据库类型与 worker 状态。

## 功能一览

- **同步**：IMAP 增量同步（UIDVALIDITY / CONDSTORE / 删除检测）、INBOX IDLE 实时收信、正文按需拉取、附件下载与缓存
- **操作**：已读 / 星标 / 归档 / 移动 / 删除 / 垃圾邮件走 outbox 回放到服务器，失败自动重试并以服务器为准纠正
- **写信**：回复 / 全部回复 / 转发（含原附件）、SMTP 发送、草稿与已发送副本 APPEND 到服务器、服务器端搜索
- **AI**：分类 + 优先级 + 摘要 + 待办抽取、AI 起草回复、每日摘要、自然语言规则、语义搜索、和邮箱对话（操作需确认）、退订助手、用量与成本面板
- **其它**：PWA（可安装、离线壳）、移动端布局、中 / 英文界面（侧栏底部切换）

## 部署（Docker）

```bash
cp .env.docker.example .env.docker   # 填写 AUTH_SECRET / APP_MASTER_KEY / 管理员账号 / APP_BASE_URL
docker compose up -d --build
```

`docker-compose.yml` 包含 PostgreSQL 与应用（含同进程 worker），数据卷 `pgdata`（数据库）与 `appdata`（附件缓存 / 上传）。
IMAP IDLE 需要长连接，因此不适合 Vercel 这类无长驻进程的平台。多实例部署会重复同步，v1 请只跑一个实例。

## 备份与恢复

- PostgreSQL：`bun run db:backup` 优先用 `pg_dump` 生成 `data/backups/pg-<时间>.sql`（恢复：`psql $DATABASE_URL < 文件`）；没有 `pg_dump` 时导出各表 JSON。
- PGlite：停止应用后 `bun run db:backup` 生成 `data/backups/pglite-<时间>.tar.gz`；恢复时把 `data/pglite` 目录改名，再用 PGlite 的 `loadDataDir` 或直接解压回 `data/pglite`。
- 邮箱凭据与 AI Key 用 `APP_MASTER_KEY` 加密，备份时请一并妥善保存该密钥。

## 目录

```
src/
├─ app/                 # 页面与路由（login、mail/*、api/*）
├─ components/          # UI 组件（shadcn/ui + 邮件组件）
├─ db/                  # Drizzle schema 与连接层（PGlite / PostgreSQL 切换）
├─ lib/                 # 前后端共用：类型、格式化、引用、i18n
├─ server/
│  ├─ ai/               # 厂商适配器、设置与路由、triage、规则、向量、Agent
│  ├─ auth/  crypto/    # 登录、凭据加密
│  ├─ jobs/             # pg-boss 队列与 worker
│  ├─ mail/             # 账号、查询、操作、发送、搜索、退订
│  ├─ oauth/            # Gmail / Outlook OAuth
│  ├─ providers/        # IMAP 提供方与预设
│  └─ sync/             # 同步引擎、IDLE、outbox 回放
drizzle/                # SQL 迁移
tests/  e2e/            # bun test / Playwright
```
