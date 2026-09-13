import sanitizeHtml from "sanitize-html";

/**
 * 邮件 HTML 安全渲染：
 * - sanitize-html 去掉脚本 / 事件属性 / 危险标签；
 * - 远程图片默认替换为占位符（隐私：防追踪像素），用户点击「显示图片」后才放行；
 * - cid: 内联图片在解析阶段已替换为 data: URL，这里允许 data:image。
 * 渲染端再放进 sandbox iframe，双重保险。
 */

const REMOTE_IMG_PLACEHOLDER =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>";

export interface SanitizeResult {
  html: string;
  blockedRemoteImages: number;
}

export function sanitizeEmailHtml(html: string, opts: { allowRemoteImages?: boolean } = {}): SanitizeResult {
  let blocked = 0;
  const clean = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img",
      "center",
      "font",
      "u",
      "s",
      "span",
      "style",
      "h1",
      "h2",
      "del",
      "ins",
    ]),
    allowedAttributes: {
      "*": ["style", "class", "align", "valign", "width", "height", "bgcolor", "color", "dir", "lang", "title"],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height", "style", "title"],
      table: ["border", "cellpadding", "cellspacing", "width", "align", "bgcolor", "style"],
      td: ["colspan", "rowspan", "width", "height", "align", "valign", "bgcolor", "style"],
      th: ["colspan", "rowspan", "width", "height", "align", "valign", "bgcolor", "style"],
      font: ["face", "size", "color"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel", "data"],
    allowedSchemesByTag: { img: ["data", "http", "https"] },
    allowProtocolRelative: false,
    // 内联 style 只保留常见排版属性（sanitize-html 会去掉 expression/url 等危险值）
    allowedStyles: {
      "*": {
        color: [/^.*$/],
        "background-color": [/^.*$/],
        background: [/^(?!.*url\().*$/i],
        "font-size": [/^.*$/],
        "font-family": [/^.*$/],
        "font-weight": [/^.*$/],
        "font-style": [/^.*$/],
        "text-align": [/^.*$/],
        "text-decoration": [/^.*$/],
        "line-height": [/^.*$/],
        margin: [/^.*$/],
        "margin-top": [/^.*$/],
        "margin-bottom": [/^.*$/],
        "margin-left": [/^.*$/],
        "margin-right": [/^.*$/],
        padding: [/^.*$/],
        "padding-top": [/^.*$/],
        "padding-bottom": [/^.*$/],
        "padding-left": [/^.*$/],
        "padding-right": [/^.*$/],
        border: [/^.*$/],
        "border-top": [/^.*$/],
        "border-bottom": [/^.*$/],
        "border-left": [/^.*$/],
        "border-right": [/^.*$/],
        "border-radius": [/^.*$/],
        "border-collapse": [/^.*$/],
        width: [/^.*$/],
        "max-width": [/^.*$/],
        height: [/^.*$/],
        display: [/^(block|inline|inline-block|table|table-cell|table-row|none|flex)$/],
        "vertical-align": [/^.*$/],
        "white-space": [/^.*$/],
        "word-break": [/^.*$/],
      },
    },
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" },
      }),
      img: (tagName, attribs) => {
        const src = attribs.src ?? "";
        if (/^https?:\/\//i.test(src) && !opts.allowRemoteImages) {
          blocked += 1;
          return { tagName, attribs: { ...attribs, src: REMOTE_IMG_PLACEHOLDER, "data-blocked-src": src } };
        }
        return { tagName, attribs };
      },
    },
    // <style> 里的 url() 也可能加载远程资源，直接丢弃 style 块内容里的 url()
    textFilter: (text, tagName) => (tagName === "style" ? text.replace(/url\s*\([^)]*\)/gi, "none") : text),
  });
  return { html: clean, blockedRemoteImages: blocked };
}

/** 纯文本正文转 HTML：转义 + 自动链接 + 换行。 */
export function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linked = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`,
  );
  return `<div style="white-space:pre-wrap;font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.6">${linked}</div>`;
}

/** 把 HTML 压成一段纯文本摘要。 */
export function htmlToSnippet(html: string, max = 200): string {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, max);
}

export function textToSnippet(text: string, max = 200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}
