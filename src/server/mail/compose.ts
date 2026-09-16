import addressparser from "nodemailer/lib/addressparser";
import MailComposer from "nodemailer/lib/mail-composer";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { EmailAddress } from "@/db/schema";
import { textToHtml } from "./html";

/**
 * 邮件组装：把编辑器内容组装成 MIME（用于 SMTP 发送与 APPEND 到草稿箱 / 已发送）。
 */

export interface ComposeAttachmentInput {
  /** 上传后的临时文件 id（data/uploads/<id>） */
  uploadId?: string;
  /** 直接给内容（转发原附件时） */
  content?: Buffer;
  filename: string;
  mimeType?: string;
}

export interface ComposeInput {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  /** 纯文本正文（编辑器内容） */
  text: string;
  /** HTML 正文；不传则由 text 生成（回复/转发会传入含富引用的 HTML） */
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: ComposeAttachmentInput[];
}

export const UPLOAD_DIR = path.resolve(process.cwd(), "data", "uploads");

export function uploadPath(id: string): string {
  const safe = id.replace(/[^0-9a-zA-Z_-]/g, "");
  return path.join(UPLOAD_DIR, safe);
}

export function removeUpload(id: string): void {
  try {
    const file = uploadPath(id);
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/** 解析用户输入的地址串："张三 <a@b.com>, c@d.com" → EmailAddress[] */
export function parseAddressList(input: string | undefined | null): EmailAddress[] {
  if (!input || !input.trim()) return [];
  const out: EmailAddress[] = [];
  for (const item of addressparser(input, { flatten: true })) {
    const address = (item.address ?? "").trim();
    if (!address || !address.includes("@")) continue;
    out.push({ name: item.name?.trim() || undefined, address });
  }
  return out;
}

function formatAddress(a: EmailAddress): string {
  return a.name ? `"${a.name.replace(/"/g, "'")}" <${a.address}>` : a.address;
}

/** 组装 MIME，返回原始字节与 Message-ID。 */
export async function buildMime(input: ComposeInput): Promise<{ mime: Buffer; messageId: string }> {
  const attachments = (input.attachments ?? []).map((a) => {
    let content = a.content;
    if (!content && a.uploadId) {
      const file = uploadPath(a.uploadId);
      if (!existsSync(file)) throw new Error(`附件 ${a.filename} 已失效，请重新上传`);
      content = readFileSync(file);
    }
    if (!content) throw new Error(`附件 ${a.filename} 没有内容`);
    return { filename: a.filename, content, contentType: a.mimeType };
  });

  const composer = new MailComposer({
    from: formatAddress(input.from),
    to: input.to.map(formatAddress),
    cc: input.cc?.map(formatAddress),
    bcc: input.bcc?.map(formatAddress),
    subject: input.subject,
    text: input.text,
    html: input.html ?? textToHtml(input.text),
    inReplyTo: input.inReplyTo,
    references: input.references?.join(" "),
    attachments,
    headers: { "X-Mailer": "Mailbox" },
  });
  const node = composer.compile();
  const messageId = node.messageId();
  const mime = await node.build();
  return { mime, messageId };
}
