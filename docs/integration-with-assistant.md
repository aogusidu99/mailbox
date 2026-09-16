# Mailbox ↔ Assistant 协同集成方案（mailbox 侧）

> 状态：**v3（2026-09-15，批注全部定稿）**。配套文档：assistant 侧见 `D:\Code\assistant\docs\integration-with-mailbox.md`（自包含，供 assistant 项目开发）。
> 本文件描述 **mailbox 项目** 的调整；总体架构与 assistant 侧改动见配套文档。

> <mark>**v3 本轮变更（相对 v2）**：① 时间信息全部取消——AI 提取/新建日程只到「日」，写成带日期的 Google 任务，地点写入任务备注；② 邮件桥定稿为「每账号一个 Assistant 文件夹」——Gmail 加 `Assistant` 标签、非 Gmail(IMAP) COPY 到「Assistant」文件夹（解决了非 Gmail 到达路径）；③ §7 待定项基本定稿。正文中 <mark>高亮部分</mark> 即本轮改动。</mark>

---

## 0. 已锁定的决策（用户批注定稿）

1. **统一以 Google 任务为结构化载体，不再单独用日历事件**：日程/任务都写成 **Google 任务**；有日期的自动显示在 Google 日历的「Tasks」图层（task 日历）。两项目**只变更 task 日历（=只写 Google 任务），不再创建 primary 独立日历事件**。
2. <mark>**时间信息全部取消**：Google 任务只用日期。AI 从邮件提取的日程、以及手动新建，都只保留**日期**（不含时间段）；**地点写入任务 `notes`（备注）**。</mark>
3. **Google 任务清单 ↔ assistant memo 分类对应；同步所有清单。** mailbox 读全部清单；写入默认进「任务」清单 `@default`（对应分类 `task`）。
4. **邮件桥标签/文件夹 = `Assistant`**；打标入口 = 规则自动（主要把重要邮件自动转给助手）+ 手动。
5. <mark>**所有账号邮件都可转给助手，到达路径定稿**：Gmail = 加 `Assistant` 标签；非 Gmail（QQ/163/Outlook 等 IMAP）= **COPY 邮件到该账号的「Assistant」文件夹**（保留原件在收件箱）。assistant 只读各账号的这个标签/文件夹。</mark>
6. **AI 配置共享：本期不做。**

---

## 1. 背景

用户同时维护两个项目、共用**同一个 Google 账号**：

- **mailbox**（本项目）：自托管 Next.js 邮件应用（PGlite/Postgres + Drizzle），已具备邮件全量双向同步、AI 处理、Google 日历 / Google 任务读写。
- **assistant**（`D:\Code\assistant`）：React + Vite + Firebase(`assistant-479610`) + Cloud Run 的 memo/日历/知识中枢；现有 memo↔Google 日历、Gmail/IMAP 只读邮件；**无 Google 任务能力（本轮新增）**。

两者都往同一 Google 账号写日历/任务，出现重复与归属不清。为此确定分工与真相源，两 App 通过 **Google 任务 + 每账号「Assistant」文件夹**解耦协同（无直接代码依赖，mailbox **不接 Firebase**）。

## 2. 目标架构与真相源

| 维度 | 真相源 | mailbox 角色 | assistant 角色 |
|---|---|---|---|
| 任务 / 日程（统一） | **Google 任务（所有清单）** | 读全部清单；「记为待办」/新建/AI 提取 → 写 Google 任务（<mark>只带日期</mark>）；双向 | 所有 memo↔Google 任务，清单=分类；双向（本轮新增） |
| 日历显示 | **task 日历（Google 任务图层）** | 日历页读取该图层 + 其它日历展示；不建 primary 事件 | 有日期任务自动显示；不建事件 |
| 邮件 | <mark>**每账号「Assistant」标签/文件夹**</mark> | 唯一收发方；<mark>Gmail 打标签 / IMAP COPY 到「Assistant」文件夹</mark> | 只读该标签/文件夹；IMAP 模块保留 |

**核心原则**：以 Google 为准 + 轮询/实时读回收敛冲突；去重键用 Google 对象 id（`googleTaskId`）。

## 3. mailbox 现状

- **日历**：`src/server/google/calendar.ts` — `listEvents` 读所有已勾选日历合并（含 task 图层、节假日）；`createEvent` 现固定写 `primary`（<mark>§0.1 后要改道到 Google 任务</mark>）；`update/deleteEvent` 按 `calendarId`。页面 `src/app/mail/calendar/*`（月/日程视图 + AI 提取日程）。
- **任务**：`src/server/google/tasks.ts` — `listAllTasks` 读所有清单；`createTask`/`createTaskFromMessage` 写 `@default`。页面 `src/app/mail/tasks/*`。摘要台「记为待办」→ `createTaskFromMessage`（`src/server/ai/digest.ts` 的 `todo` 分支）。
- **邮件↔Gmail**：全量双向（IMAP/Gmail + SMTP + outbox 回写）。操作封装 `src/server/mail/ops.ts`（`markMessages`/`moveMessages`/`setGmailLabels`/`enqueueRawOperation` 等）。
- **Google 连接**：`src/server/google/connection.ts`（scope `openid email calendar tasks`），token 存 `google_connections` 表。
- **Gmail 标签**：`setGmailLabels`（`ops.ts`）、`labelAction`（`src/app/mail/actions.ts`）。

## 4. mailbox 需要的调整

### 4.1 「转给助手」桥（核心，量小）
给用户希望 assistant 处理的邮件，归入该账号的「Assistant」标签/文件夹。
- **入口**：
  1. **规则自动**（主）：规则引擎新增动作"转给助手"——主要把**重要邮件**自动转给助手（重要性判定见 §7）。
  2. **手动**：邮件工具栏（`src/components/mail/message-toolbar.tsx`）/ 列表多选 加「转给助手」。
- <mark>**到达实现（按账号类型分流，§0.5）**：</mark>
  - <mark>**Gmail**：`setGmailLabels(...['Assistant'])` 加标签（assistant 用 `label:Assistant` 读）。</mark>
  - <mark>**非 Gmail（IMAP）**：新增一个 **COPY 到「Assistant」文件夹** 的操作（保留原件；文件夹不存在则先 IMAP `CREATE`）。需要在 `ops.ts` 增加 `copyToFolder` 类操作 + 走 outbox（`enqueueRawOperation`）；assistant 用 IMAP 只读该文件夹。</mark>
- **所有账号可用（§0.5）**：UI 对所有账号开放「转给助手」。
- **标签/文件夹名可配置**，默认 `Assistant`。

### 4.2 日历改造：不建 primary 事件，统一走 Google 任务（§0.1/§0.2）
- <mark>**「新建日程」「AI 从邮件提取日程」由"建 primary 事件"改为"建带日期的 Google 任务"**（写 `@default`）。**只保留日期，不含时间段**；**地点写入任务 `notes`**。</mark>
- <mark>AI 提取日程的结构化 schema / prompt（`src/server/ai/prompts.ts` 的 `calendarEventsSchema` / `CALENDAR_EXTRACT_SYSTEM`）相应简化为「日期 + 标题 + 地点(可选)」，去掉起止时间。</mark>
- **日历展示保留**：月/日程视图继续 `listEvents` 读所有日历（含 task 图层、只读节假日）来显示；只是不再由 mailbox 产生 primary 事件。
- `calendar.ts` 的 create/update/delete 事件接口迁移后可下线（视需要保留只读展示）。

### 4.3 任务：读全部清单（已具备）+ 默认写 @default
- 读：`listAllTasks` 已读全部清单。保持。
- 写：`createTaskFromMessage` / 新建 / AI 提取 默认写 `@default`（对应 assistant 的 `task` 分类）。可选加分类清单选择。
- `is_todo` 列已弃用（保留避免破坏性迁移）。

### 4.4 邮件：保持全量双向
mailbox 是唯一收发方，收发逻辑不变；仅新增 §4.1 的转给助手能力。

### 4.5 AI 配置共享：本期不做。

## 5. 共享常量（两端一致）

| 常量 | 值（默认） | mailbox 位置 |
|---|---|---|
| 共享任务清单（task 分类） | `@default` | `tasks.ts` |
| 邮件桥标签 / 文件夹 | `Assistant` | 新增常量/设置项 |
| 分类↔清单映射 | 见 assistant 文档 §2（@default/Ideas/Shopping/Work/Memo） | 需与 assistant 对齐 |

## 6. 实施顺序（mailbox 侧）
1. <mark>「转给助手」桥：规则动作 + 手动入口；Gmail 打标签、IMAP COPY 到「Assistant」文件夹（§4.1）——最快见效、不依赖 assistant。</mark>
2. 日历改道：新建/AI 提取 → 带日期的 Google 任务，去时间、地点入 notes（§4.2）。

## 7. 待你定的细节（非阻塞）
- [ ] 规则自动"转给助手"的**重要邮件判定**：用现有 AI 分类 `important` / 优先级 `high`，还是让用户自定义规则？（建议：默认 `important`/`high`，并允许规则自定义。）
- [ ] mailbox 写任务是否需要「分类清单选择」，还是一律 `@default`。
- [ ] 「Assistant」文件夹在各 IMAP 账号下的确切路径（如 `Assistant` vs `INBOX/Assistant`），需与 assistant 侧 IMAP 读取路径一致。

## 8. 已在 assistant 侧对应的定稿（供参考）
- 所有 memo↔Google 任务（清单=分类，5 个清单），时间取消、只到日、地点入 notes。
- 旧 memo→日历事件 批量迁移到任务并删旧事件；历史清单清理。
- Gmail 读 `label:Assistant`；非 Gmail 用保留的 IMAP 只读各账号「Assistant」文件夹。
- 轮询 + 手动同步按钮。
