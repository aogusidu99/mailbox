# Mailbox ↔ Assistant 协同集成方案（mailbox 侧）

> 状态：**v4（2026-09-16）**。配套文档：assistant 侧见 `D:\Code\assistant\docs\integration-with-mailbox.md`（自包含，供 assistant 项目开发）。
> 本文件描述 **mailbox 项目** 的协同契约与现状；总体架构与 assistant 侧改动见配套文档。

> <mark>**v4 本轮变更（相对 v3，重要方向调整）**：日历模型**回退**——不再"把所有东西都写成 Google 任务、日历只当任务图层"。改为 **日历 = 真实 Google 日历事件（带时间）**，用于会议 / 约会 / 带时间的安排；**任务 = Google 任务（只到日期）**，两者**分开**。mailbox 的日历页做成"仿 Google 日历"的整合页：中间是真实事件（月 / 周 / 日程视图），把带截止日的任务叠加成**只读「任务」图层**，右侧是任务面板。§0、§2、§3、§4 已按此重写；正文 <mark>高亮</mark> 即本轮相对 v3 的改动。任务侧（多清单、清单=分类、只到日、地点入 notes）与邮件桥（每账号 Assistant 标签 / 文件夹）**维持 v3 不变**。以下多数改动 mailbox 侧**已实现并上线**。</mark>

---

## 0. 已锁定的决策

1. <mark>**日历 = 真实 Google 日历事件（带时间）**：会议 / 约会 / 带起止时间的安排，由 mailbox 直接新建 / 编辑 / 删除**真实日历事件**（默认写主日历 `primary`，也可在新建时选择其它可写日历）。AI 从邮件提取的"带时间的会议 / 预约"也写成真实事件。**不再**把日程改道成 Google 任务。</mark>
2. **任务 = Google 任务（只到日期）**：待办 / memo 走 Google 任务；清单 = 分类，**同步所有清单**；只用日期 `due`（无时间段），`location` 等无对应字段的信息写入任务 `notes`。mailbox 读全部清单；「记为待办」/ 任务页新建 / AI 默认写「任务」清单 `@default`（对应分类 `task`）。
3. <mark>**日历页整合（仿 Google 日历）**：一个页面里 = 真实事件（月 / 周 / 日程三视图、可搜索、左侧小日历 + 日历显隐勾选）+ 把带截止日的 Google 任务叠加为**只读「任务」图层**（等价 Google 日历的 Tasks 图层）+ 右侧内嵌**任务面板**（按清单分组、可增删改）。</mark>
4. **邮件桥标签 / 文件夹 = `Assistant`**（不变）：入口 = 规则自动（把重要邮件自动转给助手）+ 手动。**Gmail = 加 `Assistant` 标签；非 Gmail（IMAP）= COPY 到该账号「Assistant」文件夹**（保留原件）。assistant 只读该标签 / 文件夹。
5. **AI 配置共享：本期不做。**

---

## 1. 背景

用户同时维护两个项目、共用**同一个 Google 账号**：

- **mailbox**（本项目）：自托管 Next.js 邮件应用（PGlite/Postgres + Drizzle），已具备邮件全量双向同步、AI 处理、Google 日历（真实事件读写）/ Google 任务（多清单读写）。
- **assistant**（`D:\Code\assistant`）：React + Vite + Firebase(`assistant-479610`) + Cloud Run 的 memo / 日历 / 知识中枢；现有 memo↔Google 日历、Gmail/IMAP 只读邮件；Google 任务能力为本轮协同新增。

两者都连同一个 Google 账号。为避免重复与归属不清，约定**真相源与分工**，两 App 通过 **Google 日历（真实事件）+ Google 任务 + 每账号「Assistant」文件夹**解耦协同（无直接代码依赖，mailbox **不接 Firebase**）。

## 2. 目标架构与真相源

| 维度 | 真相源 | mailbox 角色 | assistant 角色 |
|---|---|---|---|
| <mark>日历事件（会议 / 约会，**带时间**）</mark> | <mark>**Google 日历（真实事件）**</mark> | <mark>新建 / 编辑 / 删除真实事件（默认 `primary`，可选其它可写日历）；AI 从邮件提取带时间的会议 / 预约 → 真实事件；双向</mark> | <mark>其内容主要走任务，**不建**日历事件；如需可只读日历展示</mark> |
| 任务（待办，**只到日期**） | **Google 任务（所有清单）** | 读全部清单；「记为待办」/ 新建 / AI → 写 Google 任务（只带日期，默认 `@default`）；双向 | 所有 memo↔Google 任务，清单 = 分类；双向 |
| 邮件 | **每账号「Assistant」标签 / 文件夹** | 唯一收发方；Gmail 打标签 / IMAP COPY 到「Assistant」文件夹 | 只读该标签 / 文件夹；IMAP 模块保留 |

**核心原则**：以 Google 为准 + 轮询 / 实时读回收敛冲突。
**去重键**：<mark>日历事件用 Google 事件 `id`（`htmlLink` 可点开原事件）；任务用 `googleTaskId`。</mark>
<mark>**归属**：mailbox 拥有它创建的真实日历事件；assistant 只读、**不修改 / 删除自己没创建的日历事件**，避免互删。任务两端皆可改（Google 为准）。</mark>

## 3. mailbox 现状（已实现）

- **日历**：`src/server/google/calendar.ts`
  - `listEvents(userId, {timeMin?,timeMax?,max?})`：读**所有可见日历**并合并（含只读的节假日 / 订阅日历），按开始时间排序；每个事件带 `calendarId / calendarName / color / readOnly`。
  - <mark>`createEvent(userId, input, calendarId='primary')` / `updateEvent(...)` / `deleteEvent(...)`：对**真实事件**增删改。`CalEventInput` 支持定时（`start/end` 为 ISO 或 `datetime-local`）与全天（`allDay`，`start/end` 为 `YYYY-MM-DD`）；地点 `location`、备注 `description`。</mark>
  - `listCalendars(userId)`：返回全部日历元信息（`id/name/color/primary/readOnly`），供前端「日历显示」勾选。
- **AI 提取日程**：`src/server/google/extract-events.ts` — `proposeCalendarEvents(userId,{days})` 从近期邮件抽出**带时间**的候选（`EventCandidate`：`title/start/end/allDay/location/description/sourceFrom/sourceSubject`）；`addEventsToCalendar(userId, events)` 用 `createEvent` 落为真实事件。
- **任务**：`src/server/google/tasks.ts` — `listAllTasks` 读**所有清单**（返回 `{lists, tasks}`，任务带 `listId`）；`createTask`/`updateTask`/`deleteTask`；`createTaskFromMessage` 写 `@default`；`getDefaultTaskListId`。任务只用 `due`（日期）。
- **日历页（整合）**：`src/app/mail/calendar/calendar-workspace.tsx` — 仿 Google 日历三栏：左（小日历 + 日历显隐 + 新建 + AI 提取）、中（月 / 周 / 日程视图 + 工具栏 + 搜索）、右（内嵌 `TasksView`）。带截止日的任务经合成的只读「任务」图层（`TASK_CAL`）叠加显示。响应式：手机只留中间日历，任务走侧栏「谷歌任务」独立页。
- **邮件↔Gmail/IMAP**：全量双向；操作封装 `src/server/mail/ops.ts`。「转给助手」= `tagForAssistant(userId, ids)`：Gmail → `setGmailLabels(['Assistant'])`；IMAP → `ensureAssistantFolder` + COPY（`ASSISTANT_FOLDER = 'Assistant'`）。规则引擎动作 `assistant`（`src/server/ai/rules.ts`）。
- **Google 连接**：`src/server/google/connection.ts`（scope `openid email calendar tasks`），token 存 `google_connections` 表（AES-256-GCM 加密）。

## 4. mailbox 侧协同要点（现状说明）

### 4.1 日历：真实事件（已实现）
- 「新建日程」「AI 从邮件提取日程」产出**真实 Google 日历事件**（带时间 / 全天），写 `primary` 或用户所选可写日历；`update/deleteEvent` 直接改删真实事件。
- 日历页 `listEvents` 读所有日历合并展示（含只读节假日 / 订阅日历）；带截止日的任务另作**只读「任务」图层**叠加（不是真实事件，点击不可改，仅展示）。
- <mark>与 assistant 的边界：日历事件由 mailbox 产生 / 维护；assistant 若读日历会看到这些真实事件，请**按事件 `id` 去重、不要重复创建 / 删除**。</mark>

### 4.2 任务：多清单双向（已实现）
- 读：`listAllTasks` 读全部清单。写：`createTaskFromMessage` / 新建 / AI 默认写 `@default`（对应 assistant 的 `task` 分类）；可扩展分类清单选择。
- 只用日期 `due`；`location` 等并入 `notes`。清单 ↔ 分类映射见 §5 与 assistant 文档 §2。
- `is_todo` 列已弃用（保留避免破坏性迁移）。

### 4.3 邮件桥：转给助手（已实现）
- 入口：规则自动（把重要邮件自动转给助手）+ 邮件工具栏 / 列表多选手动。
- 到达：**Gmail** 加 `Assistant` 标签；**非 Gmail（IMAP）** COPY 到该账号「Assistant」文件夹（保留原件，文件夹不存在先建）。assistant 只读该标签 / 文件夹。
- 标签 / 文件夹名默认 `Assistant`。

### 4.4 AI 配置共享：本期不做。

## 5. 共享常量（两端一致）

| 常量 | 值（默认） | mailbox 位置 |
|---|---|---|
| 共享任务清单（task 分类） | `@default` | `tasks.ts` |
| 邮件桥标签 / 文件夹 | `Assistant` | `ops.ts`（`ASSISTANT_FOLDER`）/ Gmail 标签 |
| 分类 ↔ 清单映射 | 见 assistant 文档 §2（`@default`/`Ideas`/`Shopping`/`Work`/`Memo`） | 需与 assistant 对齐 |

## 6. mailbox 与 assistant 的边界（协同契约）

- <mark>**日历事件（带时间）= mailbox 主导**。assistant 内容走任务；若 assistant 也要往日历写真实事件，需两端另约定归属（当前默认：assistant 不建事件，避免与 mailbox 互相重复 / 覆盖）。</mark>
- **任务（只到日）= 两端共写**，Google 为准，`googleTaskId` 去重，清单 = 分类。
- **邮件 = mailbox 唯一收发方**；assistant 只读「Assistant」标签 / 文件夹。

## 7. 待定 / 后续（非阻塞）
- [ ] 规则自动"转给助手"的**重要邮件判定**：默认 `important` / 优先级 `high`，是否允许用户自定义规则细化。
- [ ] mailbox 写任务是否要「分类清单选择」，还是一律 `@default`。
- [ ] 「Assistant」文件夹在各 IMAP 账号下的确切路径（`Assistant` vs `INBOX/Assistant`），需与 assistant 侧 IMAP 读取路径一致。
- [ ] <mark>是否需要"把带时间的 Google 任务/ memo 也在 mailbox 日历上以真实事件呈现"——当前只把任务作只读图层叠加，不互转。</mark>

## 8. 已在 assistant 侧对应的约定（供参考）
- 所有 memo↔Google 任务（清单 = 分类，5 个清单），只到日、地点入 notes。
- <mark>日历：assistant 停止自建 memo→日历事件，改走 Google 任务；真实日历事件让位给 mailbox。历史 memo 日历事件按 assistant 侧方案迁移 / 清理。</mark>
- Gmail 读 `label:Assistant`；非 Gmail 用保留的 IMAP 只读各账号「Assistant」文件夹。
- 轮询 + 手动同步按钮。
