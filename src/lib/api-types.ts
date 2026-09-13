import type { EmailAddress } from "@/db/schema";

/**
 * 前后端共享的数据传输类型（Route Handler 返回值）。
 */

export interface SidebarFolder {
  id: string;
  path: string;
  name: string;
  role: string;
  depth: number;
  noSelect: boolean;
  unreadCount: number;
  totalCount: number;
}

export interface SidebarAccount {
  id: string;
  email: string;
  displayName: string | null;
  presetId: string | null;
  syncStatus: string;
  syncError: string | null;
  initialSyncDone: boolean;
  aiEnabled: boolean;
  lastSyncAt: string | null;
  folders: SidebarFolder[];
}

export interface SidebarData {
  accounts: SidebarAccount[];
}

export interface AiAnnotationDto {
  category: string | null;
  priority: string | null;
  summary: string | null;
  actionItems: Array<{ title: string; dueAt?: string; assignee?: string }>;
  reason: string | null;
}

export interface MessageListItem {
  id: string;
  accountId: string;
  folderId: string;
  uid: number;
  subject: string | null;
  from: EmailAddress[];
  to: EmailAddress[];
  date: string | null;
  snippet: string | null;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachments: boolean;
  threadId: string | null;
  bodyFetched: boolean;
  ai: AiAnnotationDto | null;
}

export interface MessageListResponse {
  items: MessageListItem[];
  nextCursor: string | null;
}

export interface AttachmentDto {
  id: string;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  inline: boolean;
  contentId: string | null;
}

export interface MessageDetail extends MessageListItem {
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  messageId: string | null;
  html: string | null;
  text: string | null;
  blockedRemoteImages: number;
  attachments: AttachmentDto[];
  headers: Record<string, string | string[]>;
  folderPath: string;
  folderRole: string;
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
}

export interface UploadedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** 写信 / 存草稿的提交内容 */
export interface ComposePayload {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  attachments: UploadedAttachment[];
  /** 回复的原邮件（本地 id） */
  inReplyToMessageId?: string;
  /** 转发的原邮件（本地 id） */
  forwardOfMessageId?: string;
  includeOriginalAttachments?: boolean;
  /** 正在编辑的草稿（本地 id），发送或再次保存后删除旧草稿 */
  draftMessageId?: string;
}

export type RealtimeEventDto =
  | { type: "hello" }
  | { type: "folder"; accountId: string; folderId?: string; folderPath?: string }
  | { type: "account"; accountId: string }
  | { type: "message"; accountId: string; folderId: string; messageId: string }
  | { type: "outbox"; accountId: string; opId: string; status: string; error?: string };
