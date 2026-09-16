import { describe, expect, test } from "bun:test";
import type { Message } from "@/db/schema";
import { textToHtml } from "@/server/mail/html";
import { htmlForwardQuote, htmlReplyQuote } from "@/server/mail/reply-html";

/** textToHtml 的「引用感知」：把 > 引用行转成嵌套 blockquote（Gmail 阶梯竖线），而不是字面 > */
describe("textToHtml 引用感知", () => {
  test("无引用文本不产生 blockquote", () => {
    const h = textToHtml("hello world\n第二行");
    expect(h).not.toContain("<blockquote");
    expect(h).toContain("hello world");
  });

  test("> 引用行转成嵌套 blockquote，去掉字面 > 前缀", () => {
    const h = textToHtml("我的回复\n\n在 2026 年，某人 写道：\n> 第一层引用\n> > 第二层引用");
    const opens = (h.match(/<blockquote/g) ?? []).length;
    const closes = (h.match(/<\/blockquote>/g) ?? []).length;
    expect(opens).toBe(2); // 两级嵌套
    expect(closes).toBe(2); // 标签闭合平衡
    expect(h).toContain("第一层引用");
    expect(h).toContain("第二层引用");
    expect(h).not.toContain("&gt; 第一层引用"); // 不再是字面 >
    expect(h).toContain("border-left"); // 阶梯竖线
  });

  test("正文里非行首的 > 不被当引用", () => {
    const h = textToHtml("a > b 的比较");
    expect(h).not.toContain("<blockquote");
    expect(h).toContain("a &gt; b 的比较");
  });
});

/** Tier-2：回复/转发把原邮件富 HTML（表格/颜色）包进 blockquote 保留 */
describe("回复/转发保留原邮件富 HTML", () => {
  const orig = {
    fromAddrs: [{ name: "Adel", address: "a@stadtweimar.de" }],
    toAddrs: [{ address: "me@x.com" }],
    date: new Date("2026-06-05T12:27:00Z"),
    subject: "Re: Antrag",
    htmlBody: '<table><tbody><tr><td style="color:red">STADTVERWALTUNG WEIMAR</td></tr></tbody></table>',
    textBody: null,
  } as unknown as Message;

  test("回复引用保留表格与颜色，包进 blockquote", () => {
    const h = htmlReplyQuote(orig);
    expect(h).toContain("<blockquote");
    expect(h).toContain("写道");
    expect(h).toContain("<table"); // 表格结构保留
    expect(h).toContain("STADTVERWALTUNG WEIMAR");
    expect(h).toContain("color:red"); // 颜色保留
  });

  test("转发引用含转发信息头 + 原邮件富 HTML", () => {
    const h = htmlForwardQuote(orig);
    expect(h).toContain("转发的邮件");
    expect(h).toContain("<blockquote");
    expect(h).toContain("STADTVERWALTUNG WEIMAR");
  });

  test("纯文本原邮件退化为 textToHtml", () => {
    const textOnly = { ...orig, htmlBody: null, textBody: "第一行\n第二行" } as unknown as Message;
    const h = htmlReplyQuote(textOnly);
    expect(h).toContain("<blockquote");
    expect(h).toContain("第一行");
  });
});
