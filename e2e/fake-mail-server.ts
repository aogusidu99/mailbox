import hoodiecrow from "hoodiecrow-imap";
import { SMTPServer } from "smtp-server";
import type { Server } from "node:net";

/**
 * 端到端测试用的本地邮件服务器：
 * - hoodiecrow：内存 IMAP（testuser@example.com / testpass）
 * - smtp-server：接受任何登录，把收到的邮件存进内存
 */

export const FAKE_IMAP_PORT = 11433;
export const FAKE_SMTP_PORT = 2526;
export const FAKE_USER = "testuser@example.com";
export const FAKE_PASS = "testpass";

const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

export function rawMessage(opts: { from: string; subject: string; id: string; date: string; body?: string; html?: string; attachment?: boolean }) {
  const headers = [
    `From: ${opts.from}`,
    `To: ${FAKE_USER}`,
    `Subject: ${encodeWord(opts.subject)}`,
    `Message-ID: <${opts.id}@example.com>`,
    `Date: ${opts.date}`,
    "MIME-Version: 1.0",
  ];
  if (opts.html || opts.attachment) {
    const html = Buffer.from(opts.html ?? "<p>Hi <b>there</b></p>", "utf8").toString("base64");
    const parts = [`--b1\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${html}\r\n`];
    if (opts.attachment) {
      parts.push(
        `--b1\r\nContent-Type: application/pdf; name="report.pdf"\r\nContent-Disposition: attachment; filename="report.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQ=\r\n`,
      );
    }
    return `${headers.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n${parts.join("")}--b1--`;
  }
  const body = Buffer.from(opts.body ?? "Hello", "utf8").toString("base64");
  return `${headers.join("\r\n")}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`;
}

export interface FakeMailServers {
  imap: Server;
  smtp: SMTPServer;
  received: string[];
  close(): Promise<void>;
}

export async function startFakeMailServers(): Promise<FakeMailServers> {
  const imap = hoodiecrow({
    plugins: ["ID", "IDLE", "ENABLE", "CONDSTORE", "SPECIAL-USE", "NAMESPACE", "UNSELECT", "AUTH-PLAIN", "SASL-IR"],
    id: { name: "hoodiecrow", version: "e2e" },
    users: { [FAKE_USER]: { password: FAKE_PASS } },
    storage: {
      INBOX: {
        messages: [
          {
            raw: rawMessage({ from: "Alice <alice@example.com>", subject: "项目周报：本周进展", id: "e1", date: "Mon, 07 Sep 2026 10:00:00 +0000", body: "大家好，本周完成了同步引擎的开发。\n\n下周计划：接入 AI 分类。" }),
          },
          {
            raw: rawMessage({ from: "Bob <bob@example.com>", subject: "发票已开具（附件）", id: "e2", date: "Tue, 08 Sep 2026 09:30:00 +0000", attachment: true, html: "<p>您好，<b>9 月</b>发票见附件。</p><img src=\"https://tracker.example.com/p.gif\">" }),
          },
          {
            raw: rawMessage({ from: "Newsletter <news@example.com>", subject: "本周精选文章", id: "e3", date: "Wed, 09 Sep 2026 08:00:00 +0000", html: "<h1>本周精选</h1><p>三篇值得一读的文章。</p>" }),
            flags: ["\\Seen"],
          },
        ],
      },
      "": {
        separator: "/",
        folders: {
          Sent: { "special-use": "\\Sent" },
          Drafts: { "special-use": "\\Drafts" },
          Trash: { "special-use": "\\Trash" },
          Archive: { "special-use": "\\Archive" },
        },
      },
    },
  });
  await new Promise<void>((resolve) => imap.listen(FAKE_IMAP_PORT, resolve));

  const received: string[] = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onAuth(_auth, _session, callback) {
      callback(null, { user: FAKE_USER });
    },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        received.push(Buffer.concat(chunks).toString("utf8"));
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(FAKE_SMTP_PORT, resolve));

  return {
    imap,
    smtp,
    received,
    close: async () => {
      await new Promise<void>((resolve) => smtp.close(() => resolve()));
      imap.close();
    },
  };
}
