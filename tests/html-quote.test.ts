import { describe, expect, test } from "bun:test";
import { textToHtml } from "@/server/mail/html";

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
