import { ImapFlow, type FetchMessageObject, type ListResponse, type MessageStructureObject, type SearchObject } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import type { EmailAddress } from "@/db/schema";
import { htmlToSnippet, textToSnippet } from "@/server/mail/html";
import type {
  ConnectionTestResult,
  EnvelopeAttachment,
  FlagChange,
  FolderRole,
  FolderState,
  IdleHandlers,
  MailOperation,
  MailProvider,
  MessageEnvelope,
  OperationResult,
  ParsedMessage,
  ProviderCapabilities,
  RemoteFolder,
} from "./types";

/**
 * 基于 imapflow + nodemailer 的通用 IMAP/SMTP 提供方。
 * 覆盖 Gmail（含 X-GM-EXT-1 标签/会话扩展）、QQ、163（自动发送 IMAP ID）、iCloud 与自定义服务器。
 */

export interface ImapAccountConfig {
  email: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  auth: { user: string; pass: string } | { user: string; accessToken: string };
}

const CLIENT_INFO = { name: "Mailbox", version: "0.1.0", vendor: "mailbox" };

/** imapflow 2 返回的标记不带反斜杠（"Seen"）；统一存储为不带反斜杠的形式。 */
export function normalizeFlag(flag: string): string {
  return flag.startsWith("\\") ? flag.slice(1) : flag;
}

const SYSTEM_FLAGS: Record<string, string> = {
  seen: "\\Seen",
  flagged: "\\Flagged",
  answered: "\\Answered",
  draft: "\\Draft",
  deleted: "\\Deleted",
  recent: "\\Recent",
};

/** 发送给服务器时把系统标记还原成带反斜杠的形式。 */
export function toImapFlag(flag: string): string {
  const n = normalizeFlag(flag);
  return SYSTEM_FLAGS[n.toLowerCase()] ?? flag;
}

const NAME_ROLE_HINTS: Array<[RegExp, FolderRole]> = [
  [/^(sent|sent messages|sent items|sent mail|已发送|已发送邮件|已发送消息|寄件备份|寄件匣)$/i, "sent"],
  [/^(drafts?|草稿|草稿箱)$/i, "drafts"],
  [/^(trash|deleted|deleted messages|deleted items|bin|已删除|已删除邮件|垃圾桶|回收站)$/i, "trash"],
  [/^(junk|spam|junk e-mail|bulk mail|垃圾邮件|垃圾郵件)$/i, "junk"],
  [/^(archive|archives|归档|存档)$/i, "archive"],
];

export function roleFromListResponse(f: ListResponse): FolderRole {
  switch (f.specialUse) {
    case "\\Inbox":
      return "inbox";
    case "\\Sent":
      return "sent";
    case "\\Drafts":
      return "drafts";
    case "\\Trash":
      return "trash";
    case "\\Junk":
      return "junk";
    case "\\Archive":
      return "archive";
    case "\\All":
      return "all";
  }
  if (f.path.toUpperCase() === "INBOX") return "inbox";
  for (const [re, role] of NAME_ROLE_HINTS) {
    if (re.test(f.name)) return role;
  }
  return "other";
}

function toAddresses(list?: Array<{ name?: string; address?: string }>): EmailAddress[] {
  if (!list) return [];
  return list
    .filter((a) => a.address)
    .map((a) => ({ name: a.name || undefined, address: a.address as string }));
}

/** 解析 FETCH 返回的原始头部片段（已按需拉取的几个头）。 */
export function parseHeaderBlock(buf?: Buffer): Record<string, string> {
  if (!buf) return {};
  const out: Record<string, string> = {};
  const lines = buf.toString("utf8").replace(/\r\n[ \t]+/g, " ").split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = out[key] ? `${out[key]} ${value}` : value;
  }
  return out;
}

function parseReferences(value?: string): string[] {
  if (!value) return [];
  return value.match(/<[^>]+>/g) ?? [];
}

/** 从 BODYSTRUCTURE 收集附件（含内联图片）。 */
export function collectAttachments(root?: MessageStructureObject): EnvelopeAttachment[] {
  const out: EnvelopeAttachment[] = [];
  if (!root) return out;
  const walk = (node: MessageStructureObject, isFirstTextPart: { done: boolean }) => {
    const type = (node.type || "").toLowerCase();
    if (node.childNodes && node.childNodes.length > 0) {
      for (const child of node.childNodes) walk(child, isFirstTextPart);
      return;
    }
    if (type.startsWith("multipart/")) return;
    const disposition = (node.disposition || "").toLowerCase();
    const filename = node.dispositionParameters?.filename || node.parameters?.name;
    const isText = type === "text/plain" || type === "text/html";
    const contentId = node.id ? node.id.replace(/^<|>$/g, "") : undefined;

    if (disposition === "attachment" || (filename && !isText)) {
      out.push({ part: node.part ?? "1", filename, mimeType: type, size: node.size, contentId, inline: false });
      return;
    }
    if (disposition === "inline" && !isText) {
      out.push({ part: node.part ?? "1", filename, mimeType: type, size: node.size, contentId, inline: true });
      return;
    }
    if (!isText && !disposition && type !== "message/delivery-status" && type !== "text/calendar") {
      // 没有 disposition 的非文本部分（常见于内嵌图片或 pdf）
      out.push({ part: node.part ?? "1", filename, mimeType: type, size: node.size, contentId, inline: Boolean(contentId) });
      return;
    }
    if (isText && !isFirstTextPart.done) isFirstTextPart.done = true;
  };
  walk(root, { done: false });
  return out;
}

/** 把 imapflow 的错误翻译成用户能看懂的中文。 */
export function describeImapError(err: unknown): string {
  const e = err as { code?: string; responseText?: string; message?: string; authenticationFailed?: boolean; serverResponseCode?: string };
  const text = `${e?.responseText ?? ""} ${e?.message ?? ""}`;
  if (/unsafe login/i.test(text)) {
    return "服务器拒绝登录（Unsafe Login）：163/126 邮箱请确认已开启 IMAP 服务，并使用「授权密码」而不是登录密码。";
  }
  if (e?.authenticationFailed || /AUTHENTICATIONFAILED|login fail|invalid credentials|authentication failed|LOGIN failed|Invalid login/i.test(text)) {
    return "认证失败：请确认填写的是「授权码 / 应用专用密码」而不是网页登录密码，并且已开启 IMAP 服务。";
  }
  if (/application-specific password required/i.test(text)) {
    return "Gmail 要求使用「应用专用密码」：请先开启两步验证，再在 Google 账号「应用专用密码」页面生成。";
  }
  switch (e?.code) {
    case "ENOTFOUND":
      return "找不到服务器主机名，请检查 IMAP/SMTP 主机地址。";
    case "ECONNREFUSED":
      return "连接被服务器拒绝，请检查端口是否正确。";
    case "ETIMEDOUT":
    case "CONNECT_TIMEOUT":
    case "ESOCKETTIMEDOUT":
      return "连接超时：请检查网络，以及 993/465 端口是否可访问。";
    case "CERT_HAS_EXPIRED":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      return "服务器证书校验失败。";
  }
  return e?.responseText || e?.message || String(err);
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

const HEADER_WHITELIST = [
  "message-id",
  "in-reply-to",
  "references",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "list-id",
  "precedence",
  "auto-submitted",
  "return-path",
  "x-mailer",
  "x-priority",
];

function headerValueToString(value: unknown): string | string[] {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : headerValueToString(v) as string));
  if (value && typeof value === "object") {
    const v = value as { text?: string; value?: unknown };
    if (typeof v.text === "string") return v.text;
    if (typeof v.value === "string") return v.value;
    return JSON.stringify(value);
  }
  return String(value);
}

const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

/** 把解析结果整理成可存库的正文：cid 内联图片替换为 data URL。 */
export function toParsedMessage(mail: ParsedMail): ParsedMessage {
  let html = typeof mail.html === "string" ? mail.html : undefined;
  const text = mail.text ?? undefined;
  if (html) {
    for (const att of mail.attachments) {
      const cid = att.cid || att.contentId?.replace(/^<|>$/g, "");
      if (!cid || !att.content || att.size > MAX_INLINE_IMAGE_BYTES) continue;
      if (!html.includes(`cid:${cid}`)) continue;
      const dataUrl = `data:${att.contentType};base64,${att.content.toString("base64")}`;
      html = html.split(`cid:${cid}`).join(dataUrl);
    }
  }
  const headers: Record<string, string | string[]> = {};
  for (const key of HEADER_WHITELIST) {
    const v = mail.headers.get(key);
    if (v !== undefined) headers[key] = headerValueToString(v);
  }
  const snippet = text ? textToSnippet(text) : html ? htmlToSnippet(html) : "";
  return { textBody: text, htmlBody: html, snippet, headers };
}

export class ImapProvider implements MailProvider {
  private client: ImapFlow | null = null;
  private caps: ProviderCapabilities = { gmail: false, condstore: false, move: false, idle: false, uidplus: false };

  constructor(private readonly cfg: ImapAccountConfig) {}

  get capabilities(): ProviderCapabilities {
    return this.caps;
  }

  private makeClient(opts: { autoIdle: boolean }): ImapFlow {
    return new ImapFlow({
      host: this.cfg.imap.host,
      port: this.cfg.imap.port,
      secure: this.cfg.imap.secure,
      auth: this.cfg.auth,
      clientInfo: CLIENT_INFO,
      logger: false,
      disableAutoIdle: !opts.autoIdle,
      connectionTimeout: 30_000,
      greetingTimeout: 20_000,
      socketTimeout: 5 * 60_000,
    });
  }

  private requireClient(): ImapFlow {
    if (!this.client || !this.client.usable) throw new Error("IMAP 连接不可用，请先 connect()");
    return this.client;
  }

  async connect(): Promise<void> {
    if (this.client?.usable) return;
    const client = this.makeClient({ autoIdle: false });
    client.on("error", (err: Error) => {
      console.warn(`[imap] ${this.cfg.email} 连接错误:`, err.message);
    });
    await client.connect();
    this.client = client;
    this.caps = {
      gmail: client.capabilities.has("X-GM-EXT-1"),
      condstore: client.capabilities.has("CONDSTORE") || client.enabled.has("CONDSTORE"),
      move: client.capabilities.has("MOVE"),
      idle: client.capabilities.has("IDLE"),
      uidplus: client.capabilities.has("UIDPLUS"),
    };
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }

  async listFolders(): Promise<RemoteFolder[]> {
    const client = this.requireClient();
    const list = await client.list();
    return list.map((f) => ({
      path: f.path,
      name: f.name,
      delimiter: f.delimiter,
      parentPath: f.parentPath || undefined,
      role: roleFromListResponse(f),
      subscribed: f.subscribed !== false,
      noSelect: f.flags.has("\\Noselect") || f.flags.has("\\NonExistent"),
    }));
  }

  async fetchFolderState(folder: string): Promise<FolderState> {
    const client = this.requireClient();
    const status = await client.status(folder, {
      messages: true,
      unseen: true,
      uidNext: true,
      uidValidity: true,
      highestModseq: this.caps.condstore,
    });
    return {
      uidValidity: Number(status.uidValidity ?? 0),
      uidNext: status.uidNext ?? 1,
      highestModseq: status.highestModseq,
      exists: status.messages ?? 0,
      unseen: status.unseen,
    };
  }

  private toEnvelope(msg: FetchMessageObject): MessageEnvelope {
    const env = msg.envelope ?? {};
    const headers = parseHeaderBlock(msg.headers);
    const attachments = collectAttachments(msg.bodyStructure);
    const date = env.date ? new Date(env.date) : undefined;
    const internalDate = msg.internalDate ? new Date(msg.internalDate) : undefined;
    return {
      uid: msg.uid,
      messageId: env.messageId || headers["message-id"] || undefined,
      inReplyTo: env.inReplyTo || headers["in-reply-to"] || undefined,
      references: parseReferences(headers["references"]),
      threadId: msg.threadId,
      subject: env.subject || undefined,
      from: toAddresses(env.from),
      to: toAddresses(env.to),
      cc: toAddresses(env.cc),
      bcc: toAddresses(env.bcc),
      replyTo: toAddresses(env.replyTo),
      date: date && !Number.isNaN(date.getTime()) ? date : internalDate,
      internalDate,
      size: msg.size,
      flags: [...(msg.flags ?? [])].map(normalizeFlag),
      hasAttachments: attachments.some((a) => !a.inline),
      attachments,
      gmLabels: msg.labels ? [...msg.labels] : undefined,
      modseq: msg.modseq,
      listUnsubscribe: headers["list-unsubscribe"],
      listUnsubscribePost: headers["list-unsubscribe-post"],
    };
  }

  async *fetchNew(folder: string, sinceUid: number, opts: { since?: Date; limit?: number } = {}): AsyncIterable<MessageEnvelope> {
    const client = this.requireClient();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      let range: number[] | string;
      if (sinceUid <= 0) {
        const query: SearchObject = opts.since ? { since: opts.since } : { all: true };
        const uids = await client.search(query, { uid: true });
        if (!uids || uids.length === 0) return;
        const sorted = [...uids].sort((a, b) => a - b);
        range = opts.limit && sorted.length > opts.limit ? sorted.slice(-opts.limit) : sorted;
      } else {
        const mailbox = client.mailbox;
        if (mailbox && mailbox.uidNext <= sinceUid + 1) return;
        range = `${sinceUid + 1}:*`;
      }
      const query = {
        uid: true,
        flags: true,
        envelope: true,
        internalDate: true,
        size: true,
        bodyStructure: true,
        threadId: this.caps.gmail,
        labels: this.caps.gmail,
        headers: ["references", "in-reply-to", "list-unsubscribe", "list-unsubscribe-post", "message-id"],
      };
      for await (const msg of client.fetch(range, query, { uid: true })) {
        // "N:*" 在 N 大于最大 UID 时会返回最后一封，必须过滤
        if (msg.uid <= sinceUid) continue;
        yield this.toEnvelope(msg);
      }
    } finally {
      lock.release();
    }
  }

  async *fetchFlags(folder: string, opts: { sinceModseq?: bigint; fromUid?: number }): AsyncIterable<FlagChange> {
    const client = this.requireClient();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      if (client.mailbox && client.mailbox.exists === 0) return;
      const range = opts.fromUid && opts.fromUid > 1 ? `${opts.fromUid}:*` : "1:*";
      const fetchOpts = opts.sinceModseq !== undefined && this.caps.condstore ? { uid: true, changedSince: opts.sinceModseq } : { uid: true };
      for await (const msg of client.fetch(range, { uid: true, flags: true, labels: this.caps.gmail }, fetchOpts)) {
        yield {
          uid: msg.uid,
          flags: [...(msg.flags ?? [])].map(normalizeFlag),
          gmLabels: msg.labels ? [...msg.labels] : undefined,
          modseq: msg.modseq,
        };
      }
    } finally {
      lock.release();
    }
  }

  async listUids(folder: string, fromUid = 1): Promise<number[]> {
    const client = this.requireClient();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      if (client.mailbox && client.mailbox.exists === 0) return [];
      const result = await client.search({ uid: `${Math.max(1, fromUid)}:*` }, { uid: true });
      if (!result) return [];
      return result.filter((uid) => uid >= fromUid);
    } finally {
      lock.release();
    }
  }

  async fetchBody(folder: string, uid: number): Promise<ParsedMessage> {
    const client = this.requireClient();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`邮件 UID ${uid} 在 ${folder} 中不存在`);
      const parsed = await simpleParser(msg.source, { skipImageLinks: false });
      return toParsedMessage(parsed);
    } finally {
      lock.release();
    }
  }

  async fetchAttachment(folder: string, uid: number, part: string): Promise<{ content: Buffer; mimeType?: string; filename?: string }> {
    const client = this.requireClient();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const dl = await client.download(String(uid), part, { uid: true });
      const content = await streamToBuffer(dl.content);
      return { content, mimeType: dl.meta.contentType, filename: dl.meta.filename };
    } finally {
      lock.release();
    }
  }

  async applyOperation(op: MailOperation): Promise<OperationResult> {
    const client = this.requireClient();
    if (op.type === "create_folder") {
      await client.mailboxCreate(op.folder);
      return {};
    }
    if (op.type === "append") {
      const res = await client.append(op.folder, Buffer.from(op.mime), op.flags?.map(toImapFlag), op.date);
      return { appendedUid: res ? res.uid : undefined };
    }
    const lock = await client.getMailboxLock(op.folder);
    try {
      switch (op.type) {
        case "set_flags":
          if (op.add?.length) await client.messageFlagsAdd(op.uids, op.add.map(toImapFlag), { uid: true });
          if (op.remove?.length) await client.messageFlagsRemove(op.uids, op.remove.map(toImapFlag), { uid: true });
          return {};
        case "set_labels":
          if (op.add?.length) await client.messageFlagsAdd(op.uids, op.add, { uid: true, useLabels: true });
          if (op.remove?.length) await client.messageFlagsRemove(op.uids, op.remove, { uid: true, useLabels: true });
          return {};
        case "move": {
          const res = await client.messageMove(op.uids, op.toFolder, { uid: true });
          const uidMap: Record<number, number> = {};
          if (res && res.uidMap) for (const [from, to] of res.uidMap) uidMap[from] = to;
          return { uidMap };
        }
        case "delete":
          await client.messageDelete(op.uids, { uid: true });
          return {};
      }
    } finally {
      lock.release();
    }
    return {};
  }

  private smtpTransport() {
    const auth =
      "pass" in this.cfg.auth
        ? { user: this.cfg.auth.user, pass: this.cfg.auth.pass }
        : { type: "OAuth2" as const, user: this.cfg.auth.user, accessToken: this.cfg.auth.accessToken };
    return nodemailer.createTransport({
      host: this.cfg.smtp.host,
      port: this.cfg.smtp.port,
      secure: this.cfg.smtp.secure,
      auth,
      connectionTimeout: 30_000,
      greetingTimeout: 20_000,
    });
  }

  async send(mime: Buffer, envelope: { from: string; to: string[] }): Promise<{ messageId?: string }> {
    const transport = this.smtpTransport();
    try {
      const info = await transport.sendMail({ envelope, raw: mime });
      return { messageId: info.messageId };
    } finally {
      transport.close();
    }
  }

  async idle(folder: string, handlers: IdleHandlers): Promise<() => Promise<void>> {
    const client = this.makeClient({ autoIdle: true });
    let stopped = false;
    const notify = () => {
      if (!stopped) handlers.onChange();
    };
    client.on("exists", notify);
    client.on("expunge", notify);
    client.on("flags", notify);
    client.on("error", (err: Error) => {
      if (!stopped) handlers.onClose(err);
    });
    client.on("close", () => {
      if (!stopped) handlers.onClose();
    });
    await client.connect();
    await client.mailboxOpen(folder, { readOnly: true });
    return async () => {
      stopped = true;
      try {
        await client.logout();
      } catch {
        client.close();
      }
    };
  }

  /** 添加邮箱向导用：分别验证 IMAP 与 SMTP 登录。 */
  static async testConnection(cfg: ImapAccountConfig): Promise<ConnectionTestResult> {
    const result: ConnectionTestResult = { imap: { ok: false }, smtp: { ok: false } };
    const provider = new ImapProvider(cfg);
    try {
      await provider.connect();
      const folders = await provider.listFolders();
      result.imap = {
        ok: true,
        folders: folders.length,
        capabilities: provider.client ? [...provider.client.capabilities.keys()] : [],
      };
    } catch (err) {
      result.imap = { ok: false, error: describeImapError(err) };
    } finally {
      await provider.disconnect();
    }
    const transport = provider.smtpTransport();
    try {
      await transport.verify();
      result.smtp = { ok: true };
    } catch (err) {
      result.smtp = { ok: false, error: describeImapError(err) };
    } finally {
      transport.close();
    }
    return result;
  }
}
