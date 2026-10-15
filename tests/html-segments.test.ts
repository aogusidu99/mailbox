import { describe, expect, test } from "bun:test";
import { segmentHtml } from "@/server/ai/html-segments";
import { sanitizeEmailHtml } from "@/server/mail/html";

/** 模拟模型：把每段译文变成「[T]原文」，占位符原样保留 */
function fakeTranslate(html: string, fn: (text: string) => string = (t) => `[T]${t}`) {
  const seg = segmentHtml(html);
  const out = seg.rebuild(new Map(seg.segments.map((s) => [s.id, fn(s.text)])));
  return { seg, out };
}

describe("HTML 保留排版翻译：分段与重建", () => {
  test("不给译文时重建结果与原文完全一致", () => {
    const html = sanitizeEmailHtml(
      `<table width="100%"><tr><td style="color:#333">Receipt from <b>Anthropic</b>, PBC</td><td>€107.10</td></tr></table><p>Questions? Visit our <a href="https://support.example.com">support site</a>.</p><style>a > b { color: red }</style>`,
      { allowRemoteImages: true },
    ).html;
    const seg = segmentHtml(html);
    expect(seg.rebuild(new Map())).toBe(html);
  });

  test("只替换文字：表格、样式、链接地址、图片保持不变", () => {
    const html = `<table width="100%"><tr><td style="color:#333"><img src="https://x.com/logo.png" alt="logo" /> Anthropic, PBC</td><td>€107.10</td></tr></table><p>Questions? Visit our <a href="https://support.example.com">support site</a>.</p>`;
    const { seg, out } = fakeTranslate(html);
    // 纯金额不需要翻译
    expect(seg.segments.map((s) => s.text)).toEqual(["Anthropic, PBC", "Questions? Visit our <g1>support site</g1>."]);
    expect(out).toBe(
      `<table width="100%"><tr><td style="color:#333"><img src="https://x.com/logo.png" alt="logo" /> [T]Anthropic, PBC</td><td>€107.10</td></tr></table><p>[T]Questions? Visit our <a href="https://support.example.com">support site</a>.</p>`,
    );
  });

  test("占位符可按目标语序移动；包住整段的标签不交给模型", () => {
    const html = `<p><span style="font-size:14px">Visit our <a href="https://s.example">support site</a> today</span></p>`;
    const { seg, out } = fakeTranslate(html, () => "今天就访问我们的<g1>支持网站</g1>");
    expect(seg.segments[0].text).toBe("Visit our <g1>support site</g1> today");
    expect(out).toBe(`<p><span style="font-size:14px">今天就访问我们的<a href="https://s.example">支持网站</a></span></p>`);
  });

  test("模型输出的占位符错乱 / 丢失时仍产出合法 HTML", () => {
    const html = `<p>Hello <b>bold <i>both</i></b> end<br />next line</p>`;
    const seg = segmentHtml(html);
    expect(seg.segments[0].text).toBe("Hello <g1>bold <g2>both</g2></g1> end<x3/>next line");
    // 关闭顺序颠倒 + 重复 + 未知编号 + 漏掉 <x3/>
    const out = seg.rebuild(new Map([[0, "你好 <g1>粗体 <g2>两者</g1></g2> <g1>重复</g1> <g9>未知</g9> 结尾 下一行"]]));
    expect(out).toBe("<p>你好 <b>粗体 <i>两者</i></b> 重复 未知 结尾 下一行</p>");
  });

  test("文字里的 < > & 正确转义，不会被当成标签", () => {
    const html = `<p>A &amp; B &lt;tag&gt;</p>`;
    const { seg, out } = fakeTranslate(html, (t) => t.replace("A", "甲"));
    expect(seg.segments[0].text).toBe("A & B &lt;tag&gt;");
    expect(out).toBe("<p>甲 &amp; B &lt;tag&gt;</p>");
  });

  test("块级元素各自成段；<pre> 内保留空白；纯网址 / 纯数字跳过", () => {
    const html = `<div>First para<div>Nested <em>block</em></div></div><pre>line 1\n  line 2</pre><p>https://example.com/x</p><p>2999-5512-0914</p><p>61LNTUKQ-0007</p>`;
    const { seg } = fakeTranslate(html);
    expect(seg.segments.map((s) => s.text)).toEqual(["First para", "Nested <g1>block</g1>", "line 1\n  line 2"]);
  });

  test("多余的结束标签（sanitize-html 输出的 </wbr>）原样保留", () => {
    const html = `<div>To: Bob<wbr></wbr></div>`;
    expect(segmentHtml(html).rebuild(new Map())).toBe(html);
  });

  test("普通 HTML 里折叠空白，首尾空白留在单元外", () => {
    const html = `<td>\n    Paid   October 3,\n    2026\n  </td>`;
    const { seg, out } = fakeTranslate(html);
    expect(seg.segments[0].text).toBe("Paid October 3, 2026");
    expect(out).toBe(`<td> [T]Paid October 3, 2026 </td>`);
  });
});
