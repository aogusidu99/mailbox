import type { EmailAddress } from "@/db/schema";

/**
 * 邮箱提供方抽象：同步引擎、outbox 回放与 AI 层只依赖这个接口。
 * 当前实现：ImapProvider（覆盖 Gmail / QQ / 163 / iCloud / 自定义 IMAP，M5 起支持 OAuth2 登录）。
 */

export type FolderRole = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "all" | "other";

export interface RemoteFolder {
  path: string;
  name: string;
  delimiter?: string;
  parentPath?: string;
  role: FolderRole;
  subscribed: boolean;
  /** \Noselect：只是层级节点，不能打开 */
  noSelect: boolean;
}

export interface FolderState {
  uidValidity: number;
  uidNext: number;
  highestModseq?: bigint;
  exists: number;
  unseen?: number;
}

export interface EnvelopeAttachment {
  /** IMAP BODY part 编号，用于按需下载 */
  part: string;
  filename?: string;
  mimeType: string;
  size?: number;
  contentId?: string;
  inline: boolean;
}

export interface MessageEnvelope {
  uid: number;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  /** 服务器提供的会话 ID（Gmail X-GM-THRID / OBJECTID） */
  threadId?: string;
  subject?: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  date?: Date;
  internalDate?: Date;
  size?: number;
  /** 已去掉反斜杠的标记名，如 "Seen"、"Flagged" */
  flags: string[];
  hasAttachments: boolean;
  attachments: EnvelopeAttachment[];
  gmLabels?: string[];
  modseq?: bigint;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
}

export interface FlagChange {
  uid: number;
  flags: string[];
  gmLabels?: string[];
  modseq?: bigint;
}

export interface ParsedMessage {
  textBody?: string;
  htmlBody?: string;
  snippet: string;
  headers: Record<string, string | string[]>;
}

/** 待回放到服务器的操作（与 mail_ops.payload 对应）。 */
export type MailOperation =
  | { type: "set_flags"; folder: string; uids: number[]; add?: string[]; remove?: string[] }
  | { type: "move"; folder: string; uids: number[]; toFolder: string }
  | { type: "delete"; folder: string; uids: number[] }
  | { type: "append"; folder: string; mime: Uint8Array; flags?: string[]; date?: Date }
  | { type: "set_labels"; folder: string; uids: number[]; add?: string[]; remove?: string[] }
  | { type: "create_folder"; folder: string };

export interface OperationResult {
  appendedUid?: number;
  /** 移动/复制后源 UID → 目标 UID 的映射（服务器支持 UIDPLUS 时） */
  uidMap?: Record<number, number>;
}

export interface ProviderCapabilities {
  gmail: boolean;
  condstore: boolean;
  move: boolean;
  idle: boolean;
  uidplus: boolean;
}

export interface IdleHandlers {
  /** 文件夹内容有变化（新邮件 / 删除 / 标记变化） */
  onChange(): void;
  /** 连接断开，调用方负责重连 */
  onClose(error?: Error): void;
}

export interface MailProvider {
  readonly capabilities: ProviderCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listFolders(): Promise<RemoteFolder[]>;
  fetchFolderState(folder: string): Promise<FolderState>;
  /** 拉取 uid > sinceUid 的邮件信封；sinceUid 为 0 时按 since 日期做初次同步 */
  fetchNew(folder: string, sinceUid: number, opts?: { since?: Date; limit?: number }): AsyncIterable<MessageEnvelope>;
  /** 拉取标记变化：支持 CONDSTORE 时传 sinceModseq，否则传 fromUid 做窗口对比 */
  fetchFlags(folder: string, opts: { sinceModseq?: bigint; fromUid?: number }): AsyncIterable<FlagChange>;
  /** 当前文件夹内 uid >= fromUid 的全部 UID（用于检测删除 / 移出） */
  listUids(folder: string, fromUid?: number): Promise<number[]>;
  /** 服务器端全文搜索（IMAP SEARCH TEXT），返回匹配的 UID */
  searchUids(folder: string, query: string): Promise<number[]>;
  /** 按 UID 列表拉取信封（服务器搜索结果回填本地缓存用） */
  fetchByUids(folder: string, uids: number[]): AsyncIterable<MessageEnvelope>;
  fetchBody(folder: string, uid: number): Promise<ParsedMessage>;
  fetchAttachment(folder: string, uid: number, part: string): Promise<{ content: Buffer; mimeType?: string; filename?: string }>;
  applyOperation(op: MailOperation): Promise<OperationResult>;
  send(mime: Buffer, envelope: { from: string; to: string[] }): Promise<{ messageId?: string }>;
  /** 实时推送（IMAP IDLE）；返回停止函数 */
  idle(folder: string, handlers: IdleHandlers): Promise<() => Promise<void>>;
}

export interface ConnectionTestResult {
  imap: { ok: boolean; error?: string; folders?: number; capabilities?: string[] };
  smtp: { ok: boolean; error?: string };
}
