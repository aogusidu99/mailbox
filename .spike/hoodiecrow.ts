// 临时验证：hoodiecrow-imap 测试服务器 + imapflow 2 能否在本机跑通（验证后删除）
import hoodiecrow from "hoodiecrow-imap";
import { ImapFlow } from "imapflow";

const server = hoodiecrow({
  plugins: ["ID", "IDLE", "ENABLE", "CONDSTORE", "SPECIAL-USE", "NAMESPACE", "UNSELECT", "X-GM-EXT-1"],
  id: { name: "hoodiecrow", version: "test" },
  storage: {
    INBOX: {
      messages: [
        { raw: "From: a@example.com\r\nTo: me@example.com\r\nSubject: hello 1\r\nMessage-ID: <m1@example.com>\r\nDate: Mon, 01 Sep 2026 10:00:00 +0000\r\n\r\nWorld 1!", flags: ["\Seen"] },
        { raw: "From: b@example.com\r\nTo: me@example.com\r\nSubject: hello 2\r\nMessage-ID: <m2@example.com>\r\nDate: Tue, 02 Sep 2026 10:00:00 +0000\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nWorld 2!\r\n--b\r\nContent-Type: application/pdf; name=\"a.pdf\"\r\nContent-Disposition: attachment; filename=\"a.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n--b--" },
      ],
    },
    "": {
      separator: "/",
      folders: {
        Sent: { "special-use": "\Sent" },
        Drafts: { "special-use": "\Drafts" },
        Trash: { "special-use": "\Trash" },
      },
    },
  },
});

await new Promise<void>((resolve) => server.listen(1143, resolve));
console.log("hoodiecrow listening on 1143");

const client = new ImapFlow({ host: "127.0.0.1", port: 1143, secure: false, auth: { user: "testuser", pass: "testpass" }, logger: false, clientInfo: { name: "mailbox-spike", version: "0" }, disableAutoIdle: true });
await client.connect();
console.log("capabilities:", [...client.capabilities.keys()].join(","));
console.log("serverInfo:", client.serverInfo);
const list = await client.list();
console.log("folders:", list.map((f) => `${f.path}[${f.specialUse ?? "-"}]`).join(" "));
const status = await client.status("INBOX", { messages: true, unseen: true, uidNext: true, uidValidity: true, highestModseq: true });
console.log("status:", status);
const lock = await client.getMailboxLock("INBOX");
try {
  console.log("mailbox:", client.mailbox && { uidValidity: client.mailbox.uidValidity, uidNext: client.mailbox.uidNext, exists: client.mailbox.exists, highestModseq: client.mailbox.highestModseq });
  const uids = await client.search({ since: new Date("2026-08-01") }, { uid: true });
  console.log("search since:", uids);
  for await (const msg of client.fetch("1:*", { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, headers: ["references", "in-reply-to"] }, { uid: true })) {
    console.log("msg", msg.uid, msg.envelope?.subject, [...(msg.flags ?? [])], msg.bodyStructure?.type, msg.bodyStructure?.childNodes?.map((c) => `${c.part}:${c.type}:${c.disposition ?? ""}`), msg.modseq, msg.headers?.toString().trim());
  }
  const one = await client.fetchOne("2", { uid: true, source: true }, { uid: true });
  console.log("source bytes:", one && one.source?.length);
  const dl = await client.download("2", "2", { uid: true });
  const chunks: Buffer[] = []; for await (const c of dl.content) chunks.push(c as Buffer);
  console.log("attachment:", dl.meta, Buffer.concat(chunks).toString("utf8"));
  await client.messageFlagsAdd("1", ["\Flagged"], { uid: true });
  const changed = await client.fetchAll("1:*", { uid: true, flags: true }, { uid: true, changedSince: 1n });
  console.log("changedSince:", changed.map((m) => [m.uid, [...(m.flags ?? [])], m.modseq]));
  const appended = await client.append("Drafts", "Subject: draft\r\n\r\nbody", ["\Draft"]);
  console.log("append:", appended);
  const moved = await client.messageMove("1", "Trash", { uid: true });
  console.log("move:", moved);
} finally {
  lock.release();
}
await client.logout();
server.close();
console.log("OK");
