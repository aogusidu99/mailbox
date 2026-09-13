# Mailbox — AI 邮件处理 Web 应用开发方案

> 状态：v1 已确认（2026-09-12），M0 已完成，进入 M1。
> 仓库：https://github.com/aogusidu99/mailbox（本地 clone 于 `D:\Code\mailbox`）。
>
> 已确认的决定：首批接入 Gmail 与 QQ（均走 IMAP 授权码，获取步骤见附录 A）；单用户自用（schema 预留多用户）；
> 开发用 PGlite、生产用 PostgreSQL；AI 默认推荐 Claude Opus 5，但采用**多厂商 + 按任务难度分级路由**，
> 模型配置方式沿用 `D:\Code\assistant` 项目（见 4.3.1），API Key 与模型选择都在设置页完成。

## 1. 目标与范围

做一个自托管的 Web 邮件客户端，核心卖点是"AI 帮你处理邮件"，并且**所有处理结果都写回邮件服务器**，
在手机/其他客户端里看到的是同一份状态。

必须满足：

1. **多邮箱**：同时接入多个账号，覆盖 Gmail、Outlook/Microsoft 365，以及任意 IMAP/SMTP 邮箱（QQ、163、iCloud、自建）。
2. **双向同步**：已读/星标/归档/移动/删除/标签、发信、草稿，全部同步到服务器；服务器上的变化也要同步回来。
3. **AI 处理**：自动分类与优先级、摘要、智能回复草稿、自然语言规则、语义搜索、"和邮箱对话"。
4. **隐私可控**：凭据加密存储；AI 处理按账号/文件夹可开关；默认屏蔽远程图片。

明确不做（v1）：日历/联系人完整管理、群发营销、多租户 SaaS 计费。

## 2. 总体架构

```
┌──────────────────────────── Next.js (Node 进程，自托管) ────────────────────────────┐
│                                                                                   │
│  app/ (App Router UI)  ──►  Server Actions / Route Handlers  ──►  服务层 (server/)   │
│        ▲                                                            │             │
│        │ SSE 实时推送                                                │             │
│        │                                                            ▼             │
│  ┌─────┴────────┐    ┌────────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ realtime     │◄───│ sync engine    │◄──►│ providers    │    │ ai           │  │
│  │ (LISTEN/     │    │ 增量同步 +     │    │ IMAP/SMTP    │    │ Claude API   │  │
│  │  NOTIFY→SSE) │    │ outbox 回写    │    │ Gmail/Graph  │    │ 分类/摘要/   │  │
│  └──────────────┘    └───────┬────────┘    └──────┬───────┘    │ 草稿/规则    │  │
│                              │                    │            └──────┬───────┘  │
│                    instrumentation.ts 启动的后台 worker（pg-boss 任务队列）        │
└──────────────────────────────┼────────────────────┼───────────────────┼──────────┘
                               ▼                    ▼                   ▼
                     PostgreSQL（生产）/ PGlite（开发）      邮件服务器          Anthropic API
                     邮件缓存 + AI 标注 + 向量 + 任务队列    (IMAP/SMTP/API)
```

关键取舍：

- **邮件服务器是唯一真相源**，本地数据库只是缓存 + AI 标注存储。任何用户/AI 操作先写本地（乐观更新）并进入 **outbox**，由 worker 回放到服务器，再以服务器状态校正本地。
- **worker 与 Web 同进程**（通过 Next.js 的 `instrumentation.ts` 在服务启动时拉起）。原因：IMAP IDLE 需要长连接，Serverless 不适合；单进程部署最简单。代码上保持 `server/sync`、`server/ai` 与 HTTP 层解耦，后续可以无痛拆成独立 worker 进程。
- **IMAP 优先，一套同步引擎覆盖所有邮箱**。Gmail/Outlook 都支持 OAuth2 (XOAUTH2) 登录 IMAP，Gmail 还提供 `X-GM-LABELS/X-GM-THRID` 扩展可直接拿到标签和会话。Gmail API / Microsoft Graph 作为可选适配器留到后期（主要收益是推送通知和更宽松的限流）。

## 3. 技术选型

| 层 | 选择 | 说明 |
|---|---|---|
| 框架 | Next.js（最新稳定版，App Router）+ TypeScript strict | 脚手架时以 `bun create next-app` 输出的版本为准 |
| 包管理/脚本 | **bun**（本机已装 1.3.11） | 本机没有 pnpm；Next 仍运行在 Node 24 上 |
| UI | Tailwind CSS + shadcn/ui + TanStack Query + TanStack Virtual | 三栏邮件布局，长列表虚拟滚动 |
| 数据库 | PostgreSQL（生产）/ **PGlite**（开发，零安装嵌入式 Postgres） | 同一套 Drizzle schema，用 `DATABASE_URL` 切换；PGlite 支持 pgvector |
| ORM/迁移 | Drizzle ORM + drizzle-kit | TS-first，轻量 |
| 任务队列 | pg-boss | 基于 Postgres，不引入 Redis |
| 邮件协议 | imapflow（IMAP）+ nodemailer（SMTP）+ mailparser（MIME 解析） | imapflow 支持 IDLE、CONDSTORE、UID MOVE、Gmail 扩展、IMAP ID（163 必需） |
| OAuth | Auth.js v5（应用登录）+ 自实现的 Google/Microsoft 邮箱授权流程 | 应用登录与"连接邮箱"是两套 OAuth，分开管理 |
| AI | 多厂商适配层：Anthropic（官方 SDK）、OpenAI、Google Gemini、DeepSeek、任意 OpenAI 兼容端点；沿用 `D:\Code\assistant` 的 provider adapter + 候选池 + 场景模型设计 | 模型列表从各厂商 `/models` 实时拉取，代码里不写死版本；API Key 在设置页填写并加密存库；默认推荐 `claude-opus-5` |
| 模型路由 | 按任务难度分级（triage / summary / extract / draft / rules / chat / embedding），每级可指定不同厂商与模型 | 未设置的等级继承全局默认；提供「省钱 / 均衡 / 质量优先」一键预设 |
| 向量 | pgvector + embedding 模型走同一套 provider 配置（Gemini / OpenAI / Voyage 等） | Anthropic 不提供 embedding，embedding 等级需选其它厂商 |
| 测试 | `bun test`（单元/服务层）+ Playwright（后期 e2e） | 同步引擎用假 provider 做确定性测试 |
| 部署 | Docker 镜像（web + 内置 worker）+ PostgreSQL，docker-compose 到 VPS | Vercel 不适合长连接 worker |

## 4. 核心设计

### 4.1 邮箱提供方抽象

所有邮箱类型实现同一个接口，同步引擎和 AI 层只依赖接口：

```ts
// server/providers/types.ts（示意）
export interface MailProvider {
  connect(): Promise<void>;
  listFolders(): Promise<Folder[]>;                       // 含 role: inbox/sent/drafts/trash/spam/archive
  fetchFolderState(folder: string): Promise<{ uidValidity: number; uidNext: number; highestModseq?: bigint }>;
  fetchNew(folder: string, sinceUid: number): AsyncIterable<MessageEnvelope>;   // 增量拉取
  fetchChanges(folder: string, sinceModseq: bigint): AsyncIterable<FlagChange>; // CONDSTORE；不支持则窗口对比
  fetchBody(folder: string, uid: number): Promise<ParsedMessage>;              // 按需取正文/附件
  applyOp(op: MailOp): Promise<void>;                     // 标记/移动/删除/打标签/存草稿
  send(mime: Buffer): Promise<void>;                      // SMTP 发送
  idle?(folder: string, onChange: () => void): Promise<() => void>; // 实时推送（可选）
}
```

首批实现：

| Provider | 登录方式 | 备注 |
|---|---|---|
| `ImapProvider`（通用） | 授权码/应用密码 | 163 需要发送 IMAP `ID` 命令否则报 Unsafe Login；QQ/163 都用"授权码"而非账号密码 |
| Gmail | 应用专用密码（需开两步验证）或 OAuth2 XOAUTH2 | 用 `X-GM-LABELS` 映射标签，`X-GM-THRID` 做会话；"归档"= 从 INBOX 移除 |
| Outlook / M365 | OAuth2 XOAUTH2（微软已禁用 IMAP 基础认证） | `outlook.office365.com:993` / `smtp.office365.com:587` |

预置常见服务商的主机/端口，用户只填邮箱和授权码即可接入。

### 4.2 同步引擎

**状态**：每个文件夹保存 `uidValidity / uidNext / highestModseq / lastSyncAt`。`uidValidity` 变化则整文件夹重建。

**下行（服务器 → 本地）**：

1. 新邮件：`UID FETCH lastUid+1:*` 取信封 + flags + 结构；最近 N 天邮件立即取正文，其余按需。
2. 标记变化：支持 CONDSTORE 时用 `CHANGEDSINCE`；否则对最近窗口（如最近 2000 个 UID）做 flags 对比。
3. 删除/移动：窗口内 UID 集合与本地对比，缺失的标记为已删除/已移出。
4. 实时：对 INBOX 开 IMAP IDLE；其他文件夹按间隔轮询（默认 5 分钟，可配）。
5. 初次同步只拉最近 30 天，历史邮件后台分批回填，避免首屏等待。

**上行（本地 → 服务器，outbox）**：

1. UI 操作立即改本地并写入 `mail_ops`（幂等键、状态、重试次数）。
2. worker 依次回放到服务器：UID MOVE / STORE FLAGS / APPEND（草稿）/ COPY+EXPUNGE 兜底。
3. 成功后对受影响文件夹做一次定向重同步；失败重试（指数退避），超限则回滚本地并在 UI 提示。
4. 冲突策略：服务器为准；未回放的本地操作在下次同步后重放。

**会话（thread）**：Gmail 用 `X-GM-THRID`；其他用 `Message-ID / In-Reply-To / References` 归并。

### 4.3 AI 能力

| 能力 | 触发 | 输入/输出 | 如何写回服务器 |
|---|---|---|---|
| 分类 + 优先级 | 新邮件到达 | 结构化输出：类别（重要/待办/通知/账单/订阅/推广/社交…）、优先级、一句话理由 | Gmail 写标签，IMAP 移入/复制到 `AI/<类别>` 文件夹（可关闭，仅本地标注） |
| 摘要 | 新邮件/会话打开 | 单封摘要、会话摘要、每日摘要页 | 仅本地 |
| 智能回复草稿 | 用户点击 / 对高优先级自动 | 按用户语气生成 1–3 个草稿 | APPEND 到服务器 Drafts，手机上也能看到 |
| 待办/日程提取 | 分类为待办时 | 事项、截止日期、相关人 | 本地待办面板；后续可导出 ICS |
| 自然语言规则 | 用户输入"把所有发票归档到 Finance" | 编译成结构化规则（条件 + 动作），可预览命中样本 | 动作走 outbox 同步 |
| 语义搜索 | 用户搜索 | 向量检索 + 关键词混合 | 仅本地 |
| 和邮箱对话 | 用户提问 | Agent（工具：search_mail / read_thread / draft_reply / apply_label / archive） | 破坏性动作需用户确认后进 outbox |
| 退订助手 | 分类为订阅 | 解析 `List-Unsubscribe`（mailto 直接发信；https 一键 POST） | SMTP 发送 |

#### 4.3.1 模型配置与按任务分级路由（沿用 assistant 项目的做法）

参考实现：`D:\Code\assistant\src\services\aiSettingsService.ts` 与 `src\services\ai\providers\*`。
mailbox 是服务端应用，所以把 localStorage 换成数据库（加密），其余概念一一对应：

| assistant 里的概念 | mailbox 的对应实现 |
|---|---|
| `ProviderAdapter`（id / name / apiKeyHint / fallbackModels / `fetchModels(apiKey)`） | `src/server/ai/providers/<id>.ts`；内置 anthropic / openai / google / deepseek，外加 OpenAI 兼容自定义端点（填 baseUrl 即可接 Moonshot、OpenRouter、Ollama 等） |
| 候选池 `candidates[provider]`：从厂商 `/models` 实时拉取后勾选，选择器只显示候选 | 同名字段存 `ai_settings.candidates`；设置页「刷新模型列表」按钮 |
| `apiKeys[provider]`（浏览器本地存储） | `ai_settings.providerKeysEnc`，AES-256-GCM 加密存库，页面只显示掩码（`maskApiKey`） |
| `roleModelsByProvider[provider][role]` 场景覆盖，留空继承默认 | `ai_settings.roles[role] = { provider, model, params }`，按任务等级路由 |
| `resolveRoleModel(role)`：覆盖 → provider 默认 → 硬编码兜底 | `resolveModel(role)`：等级配置 → 全局默认 → `FINAL_FALLBACK_MODEL`（全项目唯一写死的模型字符串） |
| `PROVIDER_FALLBACK_CHAIN` 失败降级 + 指数退避重试 | 保留：同厂商内按候选池从强到弱降级，记录到 `ai_usage.fallbackFrom` |
| 设置页：Provider 卡片、Key 输入、测试连接、场景模型下拉 | `/settings/ai` 页面同构；「测试连接」用最小请求验证 Key 与模型 |

任务等级（role）与默认建议——这就是「按不同难度的任务设置不同 AI」：

| 等级 | 对应功能 | 特点 | 默认建议 |
|---|---|---|---|
| `triage` | 分类、优先级、是否需要回复 | 高频、输入短、结构化输出 | 便宜快模型：`claude-haiku-4-5` / Gemini Flash / DeepSeek，effort low |
| `summary` | 单封 / 会话 / 每日摘要 | 高频、中等长度 | `claude-sonnet-5` 或 Gemini Flash |
| `extract` | 待办、日程、账单字段抽取 | 结构化输出、准确性重要 | `claude-sonnet-5` |
| `draft` | 回复起草、改写、翻译 | 低频、质量敏感 | `claude-opus-5`，effort high |
| `rules` | 自然语言 → 规则编译 | 低频、需要推理 | `claude-opus-5` |
| `chat` | 「和邮箱对话」Agent（工具调用） | 多轮、工具调用 | `claude-opus-5`，adaptive thinking |
| `embedding` | 语义搜索向量 | 批量 | Gemini / OpenAI / Voyage 的 embedding 模型（Anthropic 无此能力） |

- 一键预设：「质量优先」= 除 embedding 外全部 `claude-opus-5`；「均衡」= 上表默认；「省钱」= triage / summary / extract 用 Haiku 或 DeepSeek，draft / rules / chat 用 `claude-sonnet-5`。预设只是把表填好，之后仍可逐项修改。
- `params` 按厂商翻译：Anthropic → `thinking: {type: "adaptive"}` + `output_config.effort`；OpenAI → `reasoning_effort`；Gemini → `thinkingConfig`；厂商不支持的参数忽略。
- 统一调用接口：`generateText()`、`generateJson(schema)`（zod 校验；Anthropic 用结构化输出，OpenAI 用 `response_format` JSON schema，Gemini 用 `responseSchema`，其它走「提示 + 解析 + 重试」）、`embed()`。
- 通用要点：Anthropic 走 prompt caching（系统提示 + 用户画像加 `cache_control`）；历史邮件回填走 Anthropic Batch API（其它厂商按各自批量接口或限速串行）；每次调用记录 `usage` 到 `ai_usage`，设置页显示各等级成本；AI 处理按账号/文件夹 opt-in；正文超长时按会话截断策略明确提示，而不是静默截断。
- 环境变量中的 `ANTHROPIC_API_KEY` 等只作为首次启动的可选种子，正式以设置页保存的 Key 为准。

### 4.4 数据模型（主要表）

| 表 | 关键字段 |
|---|---|
| `users` | id, email, passwordHash, settings |
| `accounts` | userId, provider, email, authType, encryptedCredentials, imap/smtp 配置, aiEnabled, syncWindowDays |
| `folders` | accountId, path, role, uidValidity, uidNext, highestModseq, lastSyncAt |
| `messages` | accountId, folderId, uid, messageId, threadId, from/to/cc/bcc(json), subject, date, flags(json), snippet, hasAttachments, size, textBody, htmlBody, headers(json), gmLabels(json) |
| `attachments` | messageId, part, filename, mimeType, size, contentId, cachedPath |
| `threads` | accountId, subject, lastMessageAt, participants(json), messageCount |
| `mail_ops` | accountId, type, payload(json), idempotencyKey, status, attempts, lastError |
| `ai_annotations` | messageId, category, priority, summary, actionItems(json), reason, model, promptVersion |
| `rules` | userId, naturalText, compiled(json), enabled, lastRunAt |
| `embeddings` | messageId, chunkIndex, vector(pgvector), text |
| `ai_usage` | accountId, role, provider, model, inputTokens, outputTokens, cachedTokens, cost, fallbackFrom |
| `ai_settings` | userId, defaultProvider, defaultModel, providerKeysEnc(加密 json), candidates(json), roles(json: role → provider/model/params), preset, customProviders(json) |
| `sessions` 等 | Auth.js 所需 |

### 4.5 安全与隐私

- 邮箱凭据（授权码 / OAuth refresh token）用 AES-256-GCM 加密存库，密钥来自 `APP_MASTER_KEY` 环境变量。
- 邮件 HTML 经 DOMPurify 清洗后在 sandboxed iframe 中渲染，CSP 禁止脚本；远程图片默认屏蔽，按发件人放行。
- 日志不记录邮件正文与凭据。
- 应用登录先做单用户（管理员账号由环境变量种子生成），表结构带 `userId` 为多用户预留。
- `.env*` 不入库；仓库提供 `.env.example`。

## 5. 里程碑与验收

每个里程碑结束时都能在本地跑起来，并给出可点开验证的地址。

| 里程碑 | 内容 | 验收方式 |
|---|---|---|
| **M0 脚手架** | Next.js + TS + Tailwind + shadcn/ui；Drizzle + PGlite/Postgres 切换；Auth.js 登录；`instrumentation.ts` worker 骨架 + pg-boss；lint/typecheck/test 脚本；`.env.example`、README | `bun run dev` 后打开 `http://localhost:3000` 出现登录页；`bun run typecheck`、`bun test` 通过 |
| **M1 接入 + 只读同步** | 添加账号向导（先做 IMAP 授权码，含 Gmail/QQ/163 预设）；初次同步最近 30 天；文件夹树、虚拟滚动邮件列表、会话视图、附件下载；INBOX IDLE 实时 | 本地页面看到真实邮件；新邮件到达后几秒内出现 |
| **M2 双向操作** | 已读/星标/归档/移动/删除/垃圾 走 outbox；写信/回复/转发（引用、附件）经 SMTP；草稿存服务器；IMAP SEARCH + 本地全文搜索 | 在应用里归档一封邮件，手机邮件客户端同步可见；反向亦然 |
| **M3 AI 基础** | 新邮件自动分类 + 优先级 + 摘要；标签/文件夹写回；智能回复草稿存 Drafts；每日摘要页；按账号开关；成本面板 | 新邮件被打上类别标签并在手机上可见；草稿在其他客户端可见 |
| **M4 AI 进阶** | 自然语言规则引擎；语义搜索；"和邮箱对话" Agent；待办/日程提取；退订助手；Batch API 回填历史 | 用自然语言创建规则并命中新邮件；对话中完成"帮我找上周的发票并归档" |
| **M5 完善与部署** | Gmail/Outlook OAuth（XOAUTH2）；可选 Gmail API/Graph 推送；移动端布局 + PWA；中英文；Docker 部署；备份；e2e 测试 | docker-compose 在 VPS 上跑通完整流程 |

建议开发顺序严格按 M0→M5，每个里程碑结束提交一次代码。

## 6. 目录结构（M0 落地后）

```
mailbox/
├─ src/
│  ├─ app/                   # App Router：login、mail/…、api/auth、api/health
│  ├─ components/ui/         # shadcn/ui 组件
│  ├─ db/                    # Drizzle schema、连接层（PGlite/Postgres 切换 + 自动迁移）
│  ├─ server/
│  │  ├─ auth/               # 密码哈希、管理员种子
│  │  ├─ crypto/             # 凭据加解密（AES-256-GCM）
│  │  ├─ providers/          # MailProvider 接口 + 预设（M1 起加 imap 实现）
│  │  ├─ sync/               # M1：增量同步、outbox 回放、IDLE 管理
│  │  ├─ ai/                 # M3：Claude 调用
│  │  ├─ jobs/               # pg-boss 队列与 worker
│  │  └─ bootstrap.ts        # 启动引导：env → db → seed → worker
│  ├─ auth.ts                # Auth.js 配置
│  ├─ env.ts                 # 环境变量校验
│  └─ instrumentation.ts     # Next.js 启动钩子
├─ drizzle/                  # SQL 迁移（drizzle-kit generate 产物）
├─ scripts/setup.ts          # 生成 .env.local
├─ tests/                    # bun test
├─ docs/                     # 本方案、ADR
├─ .env.example
└─ docker-compose.yml        # M5
```

## 7. 风险与待确认事项

| 事项 | 影响 | 建议 |
|---|---|---|
| Gmail OAuth 需要 Google Cloud 项目 + 同意屏幕；"测试中"状态 refresh token 7 天过期；`gmail.modify` 属受限范围 | 个人使用可先用**应用专用密码**走 IMAP，OAuth 放到 M5 | 按全局规则，Google 授权/API 启用必须用系统默认浏览器（`Start-Process`） |
| 163/QQ 必须用「授权码」而不是网页登录密码；163 还要求客户端发送 IMAP ID 命令 | 用登录密码会报认证失败 / Unsafe Login | 授权码由用户在邮箱网页的设置里生成一次，分步骤见**附录 A**；IMAP ID 是协议细节，代码里通过 imapflow `clientInfo` 自动发送，用户不需要提供任何东西；添加邮箱向导内置分步说明与「测试连接」 |
| Outlook 个人版 IMAP OAuth 需注册 Azure 应用 | M5 才做 | 先支持 M365 与个人版共用的 XOAUTH2 流程 |
| 邮件量大时 AI 成本 | 费用 | 按任务难度分级路由（4.3.1）：高频的分类 / 摘要用便宜模型，起草 / 对话用强模型，并可一键切「省钱」预设；只处理新邮件 + 用户选择的回填范围；回填走批量接口；成本面板按等级可见 |
| 隐私：正文会发送到 Anthropic API | 用户接受度 | 按账号/文件夹 opt-in；文档明确说明 |
| 单进程 worker | 多实例部署时会重复同步 | v1 单实例；后续加分布式锁或拆独立 worker |
| 本机无 Docker / PostgreSQL / pnpm | 开发环境 | 用 bun + PGlite 零安装起步；需要真 Postgres 时再装（winget 或 Docker Desktop） |
| PGlite 0.5.8 未内置 pgvector | M4 语义搜索 | M4 时改用 PostgreSQL + pgvector，或改为外部向量存储 |
| git 提交身份未配置（`user.name/email` 为空） | 无法提交 | 首次提交前设置为 GitHub 账号信息 |

M0 验证记录（2026-09-12）：pg-boss 通过自定义 `db` 适配器在 PGlite 上跑通入队/出队；`bun run typecheck`、`bun run lint`、`bun test`（14 个用例，含内存 PGlite 真实迁移）全部通过。

M1 验证记录（2026-09-13）：IMAP 提供方（imapflow）+ 同步引擎 + IDLE 监听 + 添加邮箱向导 + 三栏界面完成。
`bun test` 新增 hoodiecrow（本地内存 IMAP 服务器）集成测试覆盖初次同步 / 正文拉取 / 标记变化 / 新邮件 / 删除；
`bun run e2e`（Playwright 驱动本机 Edge）覆盖登录 → 向导添加邮箱 → 测试连接 → 同步 → 列表 → 阅读正文与附件。
注意：pg-boss 队列名不能含冒号；Windows 上 PGlite 数据目录会被打上只读属性，Node 里的 emscripten 文件系统据此判定目录不可写，
Postgres 无法创建/删除 `postmaster.pid`（报 Permission denied，Bun 不受影响）。应用启动时会递归清除只读位并删除陈旧锁文件（`src/db/index.ts`）。

M2 验证记录（2026-09-13）：outbox 回放（已读/星标/归档/移动/删除/追加草稿）、写信/回复/全部回复/转发（SMTP + MailComposer）、
草稿与已发送副本 APPEND 到服务器、服务器端搜索（IMAP SEARCH 回填本地）完成。
`bun test` 新增 outbox 集成测试与 compose 单元测试；`bun run e2e` 新增 m2 用例：回复经假 SMTP 发出（校验 In-Reply-To）、星标、归档。

M3 验证记录（2026-09-13）：多厂商 AI 适配层（Anthropic 官方 SDK + OpenAI 兼容工厂：OpenAI / Gemini / DeepSeek / 自定义端点）、
按任务等级路由与同厂商候选池降级、用量与成本记录、triage（分类/优先级/摘要/待办 → Gmail 标签写回）、AI 起草回复、
按需分析、每日摘要页、AI 设置页（Key 加密、刷新模型列表、候选池、预设、测试连接、回填）。
`bun test` 新增假 OpenAI 兼容服务（Bun.serve）驱动的适配器 / 设置 / triage 集成测试；`bun run e2e` 新增 m3 用例（设置页配置假厂商 → AI 分析 → AI 起草）。
说明：Anthropic 的服务端 refusal fallback 未启用，遇到 refusal 时走本地候选池降级；Batch API 回填未实现，回填走普通队列（串行、可限流）。

M4 验证记录（2026-09-13）：自然语言规则（rules 等级编译 → 预览 → 保存 → 新邮件自动执行 / 立即执行，动作经 outbox 同步）、
语义搜索（embedding 等级向量化，向量以 JSON 存库、应用内余弦排序；PGlite 无 pgvector）、和邮箱对话 Agent（search_mail / semantic_search /
list_recent / read_message / propose_actions，操作只给建议、用户确认后执行）、待办面板、退订助手（RFC 8058 一键退订 / mailto / 链接）。
`bun test` 新增规则求值与编译、向量化与语义搜索、Agent 工具循环、退订测试；`bun run e2e` 新增 m4 用例（规则 → 对话 → 待办）。

需要你确认的 4 个决定：

1. **首批接入哪些邮箱**：Gmail（应用专用密码 vs OAuth）、QQ、163、Outlook？
2. **单用户自用**还是一开始就做多用户？（默认：单用户，schema 预留多用户）
3. **数据库**：开发用 PGlite 零安装、生产用 PostgreSQL？还是现在就在本机装 PostgreSQL/Docker？
4. **AI 模型**：全部用 Claude Opus 5，还是批量分类改用 Haiku 4.5 省成本？

## 8. 本地环境现状（2026-09-12）

| 工具 | 状态 |
|---|---|
| Node | v24.14.1 |
| Bun | 1.3.11 |
| pnpm | 未安装 |
| Docker | 未安装 |
| PostgreSQL | 未安装 |
| git 远端 | `origin` → https://github.com/aogusidu99/mailbox.git（空仓库，分支 main） |

## 附录 A：授权码 / 应用专用密码怎么拿

先说结论：添加邮箱时，「用户名」填完整邮箱地址，「密码」栏填的**不是**网页登录密码，而是邮箱服务商专门发给第三方客户端的一串码
（QQ / 163 叫「授权码」，Gmail 叫「应用专用密码」）。它只需要生成一次，之后加密保存在 Mailbox 里。
IMAP ID 命令之类的协议要求由程序自动处理，你不需要做任何事。

### QQ 邮箱

1. 用电脑浏览器登录 https://mail.qq.com。
2. 点顶部「设置」→「账号」（新版界面为「设置 → 账号与安全 → 安全设置」）。
3. 找到「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务」，把「IMAP/SMTP 服务」开启；第一次开启会要求用密保手机发一条短信验证。
4. 点「生成授权码」，按提示短信验证后页面显示一串 16 位字母，这就是授权码。它只显示一次，请立即复制保存。
5. 在 Mailbox 里：邮箱填 `xxx@qq.com`，密码栏粘贴授权码。

### 163 / 126 邮箱

1. 用电脑浏览器登录 https://mail.163.com（126 邮箱为 https://mail.126.com）。
2. 点顶部「设置」→「POP3/SMTP/IMAP」。
3. 开启「IMAP/SMTP 服务」，按提示用手机扫码或短信验证。
4. 验证通过后页面弹出「授权密码」（16 位），只显示一次，请立即复制保存。
5. 在 Mailbox 里：邮箱填 `xxx@163.com`，密码栏粘贴授权密码。126 邮箱的服务器是 imap.126.com / smtp.126.com，向导会按域名自动选择。

### Gmail

1. 打开 https://myaccount.google.com/security，确认「两步验证」已开启；没开先开，应用专用密码依赖它。
2. 打开 https://myaccount.google.com/apppasswords，输入一个名字（如 Mailbox），点「创建」。
3. 页面显示 16 位密码（形如 `abcd efgh ijkl mnop`），复制时可去掉空格；只显示一次。
4. 在 Mailbox 里：邮箱填 `xxx@gmail.com`，密码栏粘贴这 16 位密码。
5. 如果是公司 / 学校的 Google Workspace 账号且找不到「应用专用密码」入口，需要管理员放开，或改用 M5 的 OAuth 方式。

### 常见报错

| 报错 | 原因 | 处理 |
|---|---|---|
| `535 Login Fail` / `Authentication failed` | 用了网页登录密码 | 改用授权码 / 应用专用密码 |
| 163 `Unsafe Login` | 客户端没发 IMAP ID | Mailbox 已自动发送；若仍出现，重新生成授权码后再试 |
| Gmail `Application-specific password required` | 没用应用专用密码 | 按上面步骤生成 |
| 连接超时 | 网络或端口被拦截 | 检查 993 / 465 端口是否可达 |
