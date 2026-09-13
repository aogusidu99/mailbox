import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * 数据库 schema（Drizzle ORM，PostgreSQL 方言，PGlite 与 PostgreSQL 通用）。
 *
 * 设计原则：邮件服务器是唯一真相源，这里只是缓存 + AI 标注 + 待回放操作（outbox）。
 * 所有业务表都带 user_id / account_id，为多用户预留。
 */

// ---------- 通用 JSON 类型 ----------

export type EmailAddress = { name?: string; address: string };
export type UserSettings = { locale?: "zh-CN" | "en"; theme?: "system" | "light" | "dark" };
export type ActionItem = { title: string; dueAt?: string; assignee?: string; done?: boolean };

/** 邮件翻译目标语言（可在 AI 设置里增删；code 用 BCP-47，如 zh-CN / en / de / ja / fr） */
export interface TranslationLang {
  code: string;
  label: string;
}

/** 每日摘要里对单封邮件的「处理意见」 */
export type DigestActionType =
  | "reply"
  | "archive"
  | "trash"
  | "mark_read"
  | "flag"
  | "junk"
  | "label"
  | "todo"
  | "unsubscribe"
  | "none";

export interface DigestDisposition {
  messageId: string;
  action: DigestActionType;
  /** label：标签名；其它动作留空 */
  value?: string;
  /** 一句话说明为什么这样处理 */
  reason: string;
  /** action=reply 时给出的建议回复要点（供用户参考/补充后再生成邮件） */
  replyPoints?: string;
  /** 执行状态：pending 待处理 / done 已处理 / skipped 已跳过 */
  status?: "pending" | "done" | "skipped";
}

/** 自然语言规则编译后的结构 */
export interface RuleCondition {
  field: "from" | "to" | "subject" | "body" | "category" | "priority" | "hasAttachment" | "needsReply" | "listId";
  op: "contains" | "not_contains" | "equals" | "starts_with" | "ends_with" | "matches" | "is_true" | "is_false";
  value?: string;
}
export interface RuleAction {
  type: "archive" | "trash" | "mark_read" | "mark_unread" | "flag" | "junk" | "move" | "label";
  /** move：目标文件夹路径；label：Gmail 标签名 */
  value?: string;
}
export interface CompiledRule {
  name: string;
  match: "all" | "any";
  conditions: RuleCondition[];
  actions: RuleAction[];
  stopProcessing?: boolean;
}

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ---------- 用户 ----------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash").notNull(),
  settings: jsonb("settings").$type<UserSettings>().notNull().default({}),
  ...timestamps,
});

// ---------- 邮箱账号 ----------

export const mailProviderEnum = pgEnum("mail_provider", ["imap", "gmail", "outlook"]);
export const mailAuthTypeEnum = pgEnum("mail_auth_type", ["password", "oauth2"]);
export const syncStatusEnum = pgEnum("sync_status", ["idle", "syncing", "error", "disabled"]);

export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: mailProviderEnum("provider").notNull(),
    /** 预设 id：gmail / qq / 163 / outlook / icloud / custom */
    presetId: text("preset_id"),
    email: text("email").notNull(),
    displayName: text("display_name"),
    authType: mailAuthTypeEnum("auth_type").notNull().default("password"),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull().default(993),
    imapSecure: boolean("imap_secure").notNull().default(true),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull().default(465),
    smtpSecure: boolean("smtp_secure").notNull().default(true),
    /** 加密后的凭据 JSON（授权码或 OAuth token），见 server/crypto/secrets.ts */
    credentialsEnc: text("credentials_enc").notNull(),
    aiEnabled: boolean("ai_enabled").notNull().default(false),
    /** 回复邮件时是否自动密送（BCC）一份给自己 */
    bccSelfOnReply: boolean("bcc_self_on_reply").notNull().default(false),
    syncWindowDays: integer("sync_window_days").notNull().default(30),
    syncStatus: syncStatusEnum("sync_status").notNull().default("idle"),
    syncError: text("sync_error"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    /** 初次同步是否完成（完成前列表可能不全） */
    initialSyncDone: boolean("initial_sync_done").notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("mail_accounts_user_email_uq").on(t.userId, t.email)],
);

// ---------- 文件夹 ----------

export const folderRoleEnum = pgEnum("folder_role", [
  "inbox",
  "sent",
  "drafts",
  "trash",
  "junk",
  "archive",
  "all",
  "other",
]);

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    /** IMAP 完整路径，如 "INBOX"、"[Gmail]/All Mail" */
    path: text("path").notNull(),
    name: text("name").notNull(),
    delimiter: text("delimiter"),
    role: folderRoleEnum("role").notNull().default("other"),
    /** \Noselect：只是层级节点 */
    noSelect: boolean("no_select").notNull().default(false),
    // 增量同步状态
    uidValidity: bigint("uid_validity", { mode: "number" }),
    uidNext: bigint("uid_next", { mode: "number" }),
    highestModseq: bigint("highest_modseq", { mode: "bigint" }),
    totalCount: integer("total_count").notNull().default(0),
    unreadCount: integer("unread_count").notNull().default(0),
    subscribed: boolean("subscribed").notNull().default(true),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("folders_account_path_uq").on(t.accountId, t.path)],
);

// ---------- 邮件 ----------

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    uid: bigint("uid", { mode: "number" }).notNull(),
    messageId: text("message_id"),
    threadId: text("thread_id"),
    subject: text("subject"),
    fromAddrs: jsonb("from_addrs").$type<EmailAddress[]>().notNull().default([]),
    toAddrs: jsonb("to_addrs").$type<EmailAddress[]>().notNull().default([]),
    ccAddrs: jsonb("cc_addrs").$type<EmailAddress[]>().notNull().default([]),
    bccAddrs: jsonb("bcc_addrs").$type<EmailAddress[]>().notNull().default([]),
    replyToAddrs: jsonb("reply_to_addrs").$type<EmailAddress[]>().notNull().default([]),
    date: timestamp("date", { withTimezone: true }),
    internalDate: timestamp("internal_date", { withTimezone: true }),
    size: integer("size"),
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    seen: boolean("seen").notNull().default(false),
    flagged: boolean("flagged").notNull().default(false),
    answered: boolean("answered").notNull().default(false),
    draft: boolean("draft").notNull().default(false),
    snippet: text("snippet"),
    textBody: text("text_body"),
    htmlBody: text("html_body"),
    headers: jsonb("headers").$type<Record<string, string | string[]>>(),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    bodyFetchedAt: timestamp("body_fetched_at", { withTimezone: true }),
    /** Gmail 标签（X-GM-LABELS） */
    gmLabels: jsonb("gm_labels").$type<string[]>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("messages_folder_uid_uq").on(t.folderId, t.uid),
    index("messages_account_date_idx").on(t.accountId, t.date),
    index("messages_folder_date_idx").on(t.folderId, t.date),
    index("messages_thread_idx").on(t.threadId),
    index("messages_message_id_idx").on(t.messageId),
  ],
);

export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id")
    .notNull()
    .references(() => messages.id, { onDelete: "cascade" }),
  /** MIME part 编号，用于按需从服务器拉取 */
  part: text("part").notNull(),
  filename: text("filename"),
  mimeType: text("mime_type"),
  size: integer("size"),
  contentId: text("content_id"),
  inline: boolean("inline").notNull().default(false),
  cachedPath: text("cached_path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------- outbox：待回放到服务器的操作 ----------

export const mailOpStatusEnum = pgEnum("mail_op_status", ["pending", "applying", "applied", "failed"]);

export const mailOps = pgTable(
  "mail_ops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    /** 操作类型：mark_seen / flag / move / delete / append_draft / label ... */
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: mailOpStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("mail_ops_idem_uq").on(t.idempotencyKey),
    index("mail_ops_status_idx").on(t.status, t.nextAttemptAt),
  ],
);

// ---------- AI ----------

export const aiAnnotations = pgTable("ai_annotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id")
    .notNull()
    .unique()
    .references(() => messages.id, { onDelete: "cascade" }),
  category: text("category"),
  priority: text("priority"),
  summary: text("summary"),
  actionItems: jsonb("action_items").$type<ActionItem[]>().notNull().default([]),
  reason: text("reason"),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiUsage = pgTable("ai_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").references(() => mailAccounts.id, { onDelete: "set null" }),
  /** 任务等级：triage / summary / extract / draft / rules / chat / embedding */
  feature: text("feature").notNull(),
  provider: text("provider").notNull().default("anthropic"),
  model: text("model").notNull(),
  /** 若发生降级，记录原本想用的模型 */
  fallbackFrom: text("fallback_from"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costUsd: doublePrecision("cost_usd").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 用户级 AI 配置（多厂商、候选池、按任务等级路由）；API Key 单独加密存储 */
export const aiSettings = pgTable("ai_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  data: jsonb("data").$type<AiSettingsData>().notNull(),
  /** 加密 JSON：{ [providerId]: apiKey } */
  providerKeysEnc: text("provider_keys_enc"),
  ...timestamps,
});

/**
 * @deprecated 旧的每日摘要缓存，已被 digestReports 取代。保留表定义仅为避免破坏性迁移（缓存可再生），代码里不再使用。
 */
export const aiDigests = pgTable(
  "ai_digests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    content: text("content").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_digests_user_day_uq").on(t.userId, t.day)],
);

/** 邮件翻译缓存（按 messageId + 目标语言去重） */
export const messageTranslations = pgTable(
  "message_translations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** 目标语言 BCP-47 code */
    lang: text("lang").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("message_translations_msg_lang_uq").on(t.messageId, t.lang)],
);

/** 「和邮箱对话」会话（持久化历史，可多轮续聊） */
export const chatThreads = pgTable(
  "chat_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("新对话"),
    ...timestamps,
  },
  (t) => [index("chat_threads_user_idx").on(t.userId, t.updatedAt)],
);

/** 会话里的一条消息（用户或助手；助手消息可带操作建议与检索轨迹） */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    proposals: jsonb("proposals").$type<Record<string, unknown>[]>(),
    trace: jsonb("trace").$type<Record<string, unknown>[]>(),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_messages_thread_idx").on(t.threadId, t.createdAt)],
);

/** 摘要报告缓存（按时间段：当天 / 本周 / 本月 / 自上次以来 / 自定义），含每封邮件的处理意见 */
export const digestReports = pgTable(
  "digest_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 唯一键：day:YYYY-MM-DD / week:YYYY-MM-DD / month:YYYY-MM / since:<iso> / custom:<from>..<to> */
    periodKey: text("period_key").notNull(),
    /** day / week / month / since / custom */
    kind: text("kind").notNull().default("day"),
    fromTs: timestamp("from_ts", { withTimezone: true }).notNull(),
    toTs: timestamp("to_ts", { withTimezone: true }).notNull(),
    content: text("content"),
    plan: jsonb("plan").$type<DigestDisposition[]>().notNull().default([]),
    model: text("model"),
    ...timestamps,
  },
  (t) => [uniqueIndex("digest_reports_user_period_uq").on(t.userId, t.periodKey)],
);

/** OAuth 应用凭据（Google Cloud / Azure 注册的 client id & secret），用于 Gmail / Outlook 授权登录 */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** google | microsoft */
    provider: text("provider").notNull(),
    clientId: text("client_id").notNull(),
    clientSecretEnc: text("client_secret_enc").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("oauth_clients_user_provider_uq").on(t.userId, t.provider)],
);

/** 自然语言规则 */
export const rules = pgTable("rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** 为空表示对所有账号生效 */
  accountId: uuid("account_id").references(() => mailAccounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  naturalText: text("natural_text").notNull(),
  compiled: jsonb("compiled").$type<CompiledRule>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  runCount: integer("run_count").notNull().default(0),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  ...timestamps,
});

/** 邮件向量（PGlite 没有 pgvector，向量以 JSON 数组存储、在应用内做余弦排序） */
export const messageEmbeddings = pgTable(
  "message_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull().default(0),
    model: text("model").notNull(),
    dims: integer("dims").notNull(),
    vector: jsonb("vector").$type<number[]>().notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("message_embeddings_message_chunk_uq").on(t.messageId, t.chunkIndex), index("message_embeddings_account_idx").on(t.accountId)],
);

export type AiRole = "triage" | "summary" | "translate" | "extract" | "draft" | "rules" | "chat" | "embedding";
export type AiEffort = "low" | "medium" | "high" | "xhigh" | "max";
export interface AiRoleConfig {
  provider?: string;
  model?: string;
  effort?: AiEffort;
}
export interface AiRemoteModel {
  id: string;
  name: string;
  description?: string;
  createdAt?: number;
}
export interface AiCustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyHint?: string;
}
export interface AiSettingsData {
  defaultProvider: string;
  defaultModel: string;
  /** 各厂商的候选池（从 /models 拉取后勾选） */
  candidates: Record<string, AiRemoteModel[]>;
  /** 按任务等级覆盖；留空继承默认 */
  roles: Partial<Record<AiRole, AiRoleConfig>>;
  preset: "quality" | "balanced" | "economy" | "custom";
  customProviders: AiCustomProvider[];
  /** 分类结果写回服务器：Gmail 标签 / IMAP 复制到 AI/<类别> 文件夹 */
  writeBack: { gmailLabels: boolean; imapFolders: boolean };
  /** 自动分析范围：只收件箱 / 全部文件夹 */
  autoTriageScope: "inbox" | "all";
  /** 邮件翻译目标语言（可增删，默认 中/英/德） */
  translationLangs: TranslationLang[];
}

// ---------- 推导类型 ----------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type MailAccount = typeof mailAccounts.$inferSelect;
export type NewMailAccount = typeof mailAccounts.$inferInsert;
export type Folder = typeof folders.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MailOp = typeof mailOps.$inferSelect;
export type AiAnnotation = typeof aiAnnotations.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type MessageEmbedding = typeof messageEmbeddings.$inferSelect;
export type MessageTranslation = typeof messageTranslations.$inferSelect;
export type ChatThread = typeof chatThreads.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type DigestReport = typeof digestReports.$inferSelect;
