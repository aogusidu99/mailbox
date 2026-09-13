import { describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";
import { forwardSubject, quoteText, replyAllRecipients, replySubject, stripHtml } from "@/lib/quote";
import { buildMime, parseAddressList } from "@/server/mail/compose";

describe("compose", () => {
  test("parseAddressList 解析带名字与多个地址", () => {
    expect(parseAddressList('张三 <a@b.com>, c@d.com; "Li, Si" <e@f.com>')).toEqual([
      { name: "张三", address: "a@b.com" },
      { name: undefined, address: "c@d.com" },
      { name: "Li, Si", address: "e@f.com" },
    ]);
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList("not-an-address")).toEqual([]);
  });

  test("buildMime 生成可被解析的 MIME（中文主题、引用头、附件）", async () => {
    const { mime, messageId } = await buildMime({
      from: { name: "我", address: "me@example.com" },
      to: [{ name: "张三", address: "a@b.com" }],
      cc: [{ address: "c@d.com" }],
      subject: "Re: 项目周报",
      text: "收到，谢谢。\n\n> 原文",
      inReplyTo: "<orig@example.com>",
      references: ["<root@example.com>", "<orig@example.com>"],
      attachments: [{ filename: "报告.txt", mimeType: "text/plain", content: Buffer.from("hello") }],
    });
    expect(messageId).toMatch(/^<.+@.+>$/);
    const parsed = await simpleParser(mime);
    expect(parsed.subject).toBe("Re: 项目周报");
    expect(parsed.from?.value[0]).toEqual({ name: "我", address: "me@example.com" });
    expect(parsed.inReplyTo).toBe("<orig@example.com>");
    expect(parsed.references).toEqual(["<root@example.com>", "<orig@example.com>"]);
    expect(parsed.text?.trim()).toBe("收到，谢谢。\n\n> 原文");
    expect(parsed.html).toContain("收到，谢谢。");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("报告.txt");
    expect(parsed.attachments[0].content.toString()).toBe("hello");
  });

  test("主题与引用辅助函数", () => {
    expect(replySubject("hello")).toBe("Re: hello");
    expect(replySubject("Re: hello")).toBe("Re: hello");
    expect(replySubject("回复：hello")).toBe("回复：hello");
    expect(forwardSubject("hello")).toBe("Fwd: hello");
    expect(stripHtml("<p>Hi <b>there</b></p><br>next")).toBe("Hi there\n\nnext");
    expect(stripHtml("<div>a</div><div>b</div>")).toBe("a\nb");
    const q = quoteText({ from: [{ name: "Alice", address: "alice@x.com" }], date: "2026-09-08T10:00:00.000Z", text: "line1\nline2", html: null });
    expect(q).toContain("Alice <alice@x.com> 写道：");
    expect(q).toContain("> line1\n> line2");
  });

  test("replyAllRecipients 去掉自己并去重", () => {
    const r = replyAllRecipients({
      from: [{ address: "alice@x.com" }],
      replyTo: [],
      to: [{ address: "me@x.com" }, { address: "bob@x.com" }],
      cc: [{ address: "alice@x.com" }, { address: "carol@x.com" }],
      self: "ME@x.com",
    });
    expect(r.to.map((a) => a.address)).toEqual(["alice@x.com"]);
    expect(r.cc.map((a) => a.address)).toEqual(["bob@x.com", "carol@x.com"]);
  });
});
