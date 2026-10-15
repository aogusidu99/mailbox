/**
 * 「保留格式」的 HTML 邮件翻译：只翻译文字，不碰标签 / 样式 / 图片 / 链接地址。
 *
 * 做法（类似「沉浸式翻译」）：
 * 1. 把已清洗的邮件 HTML 解析成一棵轻量节点树；
 * 2. 以块级元素（p / div / td / li / h1 …）为边界，把相邻的「纯行内」内容（文字 + a / b / span / br …）
 *    合成一个翻译单元；单元里的行内标签替换成占位符 `<g1>…</g1>`、`<x2/>`，
 *    让模型知道「这几个词是链接 / 加粗」，翻译时可按目标语言语序挪动位置；
 * 3. 模型只返回每个单元的译文；
 * 4. 把占位符还原成原始标签，按原树结构拼回 HTML——表格、样式、图片、链接全部原样保留。
 *
 * 输入约定：经过 sanitize-html 清洗的 HTML。清洗后属性值里的 < > " 都已转义、
 * 文本里只有 &amp; &lt; &gt; &quot; 几种实体、<style> 内容是原样文本，
 * 所以一个小的正则分词器就够了，不需要完整的 HTML5 解析器。
 */

/** 自闭合（无结束标签）元素 */
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** 行内元素：可以出现在一个翻译单元内部（以占位符形式交给模型）。img 不在内——图片当作单元边界，避免模型弄丢它 */
const INLINE_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "big", "br", "cite", "code", "data", "del", "dfn", "em", "font", "i", "ins",
  "kbd", "label", "mark", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "tt", "u", "wbr",
]);

/** 一个行内片段的文字超过这个长度时，在顶层 <br> 处再拆开（纯 <br> 排版的长邮件，免得单段过长） */
const LONG_RUN_CHARS = 1200;

type HNode =
  | { kind: "text"; raw: string }
  | { kind: "raw"; raw: string }
  | { kind: "el"; tag: string; open: string; children: HNode[]; isVoid: boolean }
  | { kind: "unit"; id: number };

type ElNode = Extract<HNode, { kind: "el" }>;

interface Unit {
  /** 单元外侧要原样保留的前缀 / 后缀（首尾空白、被剥掉的整段包裹标签） */
  before: string;
  after: string;
  /** 占位符编号 → 原始标签；close 为 null 表示自闭合（<br> 等） */
  placeholders: Map<number, { open: string; close: string | null }>;
  /** 没有译文时回退用的原始 HTML */
  original: string;
}

export interface HtmlSegment {
  id: number;
  /** 交给模型翻译的文字（含占位符） */
  text: string;
}

export interface SegmentedHtml {
  segments: HtmlSegment[];
  /** 用各段译文重建 HTML；缺失 / 为空的段保留原文 */
  rebuild(translations: Map<number, string>): string;
}

// 分词：<style>/<script> 等整块原样保留；注释、doctype 原样；其余是开始 / 结束标签或文本
const TOKEN_RE = /<(style|script|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+|</gi;
// 模型输出里的占位符：<g1> </g1> <x2/>（容忍多余空格）
const PLACEHOLDER_RE = /<(\/?)\s*([gx])(\d+)\s*(\/?)\s*>/gi;

/** 把清洗后的 HTML 解析成节点树（宽松：多余的结束标签忽略，未闭合的在末尾自动闭合） */
function parse(html: string): HNode[] {
  const root: ElNode = { kind: "el", tag: "#root", open: "", children: [], isVoid: false };
  const stack: ElNode[] = [root];
  for (const m of html.matchAll(TOKEN_RE)) {
    const tok = m[0];
    const top = stack[stack.length - 1];
    if (m[1] || tok.startsWith("<!")) {
      top.children.push({ kind: "raw", raw: tok });
      continue;
    }
    const tm = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(tok);
    if (!tm) {
      top.children.push({ kind: "text", raw: tok });
      continue;
    }
    const tag = tm[2].toLowerCase();
    if (tm[1]) {
      // 结束标签：弹到匹配的那一层；找不到匹配（如 sanitize-html 输出的 </wbr>）就原样保留
      const at = stack.findLastIndex((s, i) => i > 0 && s.tag === tag);
      if (at > 0) stack.length = at;
      else top.children.push({ kind: "raw", raw: tok });
      continue;
    }
    const isVoid = VOID_TAGS.has(tag) || /\/\s*>$/.test(tok);
    const el: ElNode = { kind: "el", tag, open: tok, children: [], isVoid };
    top.children.push(el);
    if (!isVoid) stack.push(el);
  }
  return root.children;
}

/** 节点子树是否「纯行内」（可整体放进一个翻译单元） */
function isInline(n: HNode, memo: WeakMap<ElNode, boolean>): boolean {
  if (n.kind === "text") return true;
  if (n.kind !== "el" || !INLINE_TAGS.has(n.tag)) return false;
  const hit = memo.get(n);
  if (hit !== undefined) return hit;
  const v = n.children.every((c) => isInline(c, memo));
  memo.set(n, v);
  return v;
}

/** 该元素内部是否要保留原始空白（<pre>、white-space:pre*） */
function preservesWhitespace(el: ElNode): boolean {
  return el.tag === "pre" || /white-space\s*:\s*pre/i.test(el.open);
}

function isBlankText(n: HNode): boolean {
  return n.kind === "text" && /^\s*$/.test(n.raw);
}

/** 文本节点里的纯文字长度（粗略，用于判断是否拆分长片段） */
function textLength(nodes: HNode[]): number {
  let len = 0;
  for (const n of nodes) {
    if (n.kind === "text") len += n.raw.length;
    else if (n.kind === "el") len += textLength(n.children);
  }
  return len;
}

/** 在顶层 <br> 处拆分；<br> 自己单独成组（不会成为翻译单元，原样保留） */
function splitAtBr(run: HNode[]): HNode[][] {
  const pieces: HNode[][] = [];
  let cur: HNode[] = [];
  for (const n of run) {
    if (n.kind === "el" && n.tag === "br") {
      if (cur.length) pieces.push(cur);
      pieces.push([n]);
      cur = [];
    } else cur.push(n);
  }
  if (cur.length) pieces.push(cur);
  return pieces;
}

/** HTML 文本 → 给模型看的文字：解开 &amp; &quot;，保留 &lt; &gt;（避免和占位符混淆） */
function toModelText(raw: string, preserve: boolean): string {
  const s = raw.replace(/&(amp|quot);/g, (_, e: string) => (e === "amp" ? "&" : '"'));
  // 普通 HTML 里连续空白在渲染时本来就会折叠成一个空格；&nbsp;（ ）不折叠
  return preserve ? s : s.replace(/[ \t\n\r\f]+/g, " ");
}

/** 模型输出的文字 → 安全的 HTML 文本 */
function toHtmlText(s: string): string {
  const decoded = s.replace(/&(lt|gt|quot|apos|nbsp|amp|#39|#x27);/gi, (_, e: string) => {
    switch (e.toLowerCase()) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "nbsp":
        return " ";
      case "amp":
        return "&";
      default:
        return "'";
    }
  });
  return decoded.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serialize(nodes: HNode[], renderUnit: (id: number) => string): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text" || n.kind === "raw") out += n.raw;
    else if (n.kind === "unit") out += renderUnit(n.id);
    else out += n.isVoid ? n.open : `${n.open}${serialize(n.children, renderUnit)}</${n.tag}>`;
  }
  return out;
}

/**
 * 把译文里的占位符还原成原始标签。容错：
 * - 未知编号 / 重复出现的占位符忽略；
 * - 结束标签顺序错乱时按栈补齐，末尾自动闭合未闭合的标签；
 * - 模型漏掉的占位符就丢失对应格式（文字仍在）。
 */
function restore(translated: string, placeholders: Unit["placeholders"]): string {
  let out = "";
  let last = 0;
  const stack: number[] = [];
  const used = new Set<number>();
  for (const m of translated.matchAll(PLACEHOLDER_RE)) {
    out += toHtmlText(translated.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === "/";
    const id = Number(m[3]);
    const ph = placeholders.get(id);
    if (!ph) continue;
    if (ph.close === null) {
      // 自闭合（<br> 等）
      if (!closing && !used.has(id)) {
        used.add(id);
        out += ph.open;
      }
      continue;
    }
    if (!closing) {
      if (m[4] === "/" || used.has(id)) continue; // <g1/> 这种空标签、重复的开始标签都忽略
      used.add(id);
      stack.push(id);
      out += ph.open;
      continue;
    }
    const at = stack.lastIndexOf(id);
    if (at < 0) continue;
    while (stack.length > at) out += placeholders.get(stack.pop()!)!.close;
  }
  out += toHtmlText(translated.slice(last));
  while (stack.length) out += placeholders.get(stack.pop()!)!.close;
  return out;
}

/** 拆分 HTML 为待翻译片段；返回的 rebuild() 用译文拼回完整 HTML */
export function segmentHtml(html: string): SegmentedHtml {
  const units: Unit[] = [];
  const segments: HtmlSegment[] = [];
  const memo = new WeakMap<ElNode, boolean>();
  const original = (nodes: HNode[]) => serialize(nodes, () => "");

  /** 一组相邻的行内节点 → 翻译单元（没有可翻译文字时原样返回） */
  const makeUnit = (nodes: HNode[], preserve: boolean): HNode[] => {
    let before = "";
    let after = "";
    let core = nodes;
    // 剥掉首尾空白节点和「包住整段」的单个行内标签，放到单元外侧原样保留，减少交给模型的占位符
    for (;;) {
      while (core.length && isBlankText(core[0])) {
        before += (core[0] as { raw: string }).raw;
        core = core.slice(1);
      }
      while (core.length && isBlankText(core[core.length - 1])) {
        after = (core[core.length - 1] as { raw: string }).raw + after;
        core = core.slice(0, -1);
      }
      const only = core.length === 1 ? core[0] : null;
      if (only?.kind === "el" && !only.isVoid) {
        before += only.open;
        after = `</${only.tag}>${after}`;
        core = only.children;
        continue;
      }
      break;
    }

    const placeholders: Unit["placeholders"] = new Map();
    let counter = 0;
    const build = (ns: HNode[]): string =>
      ns
        .map((n) => {
          if (n.kind === "text") return toModelText(n.raw, preserve);
          if (n.kind !== "el") return "";
          const id = ++counter;
          if (n.isVoid) {
            placeholders.set(id, { open: n.open, close: null });
            return `<x${id}/>`;
          }
          placeholders.set(id, { open: n.open, close: `</${n.tag}>` });
          return `<g${id}>${build(n.children)}</g${id}>`;
        })
        .join("");
    let text = build(core);

    // 不用翻译：没有任何字母（纯数字 / 金额 / 符号）、只是一个网址 / 邮箱、或带数字的单个编号（如 61LNTUKQ-0001）
    const plain = text.replace(PLACEHOLDER_RE, "").replace(/&(lt|gt);/g, " ").trim();
    if (
      !/\p{L}/u.test(plain) ||
      /^(https?:\/\/\S+|[\w.+-]+@[\w-]+(\.[\w-]+)+)$/i.test(plain) ||
      (/\d/.test(plain) && /^[\p{L}\d#_./:-]+$/u.test(plain))
    ) {
      return nodes;
    }

    // 首尾空白挪到单元外侧（译文替换的是中间部分）
    const lead = /^\s*/.exec(text)![0];
    const trail = /\s*$/.exec(text)![0];
    text = text.slice(lead.length, text.length - trail.length);

    const id = units.length;
    units.push({ before: before + lead, after: trail + after, placeholders, original: original(nodes) });
    segments.push({ id, text });
    return [{ kind: "unit", id }];
  };

  /** 遍历子节点：相邻的行内节点合成单元，块级元素递归进入 */
  const group = (children: HNode[], preserve: boolean): HNode[] => {
    const out: HNode[] = [];
    let run: HNode[] = [];
    const flush = () => {
      if (!run.length) return;
      const pieces = textLength(run) > LONG_RUN_CHARS ? splitAtBr(run) : [run];
      for (const piece of pieces) out.push(...makeUnit(piece, preserve));
      run = [];
    };
    for (const n of children) {
      if (isInline(n, memo)) {
        run.push(n);
        continue;
      }
      flush();
      if (n.kind === "el" && !n.isVoid) n.children = group(n.children, preserve || preservesWhitespace(n));
      out.push(n);
    }
    flush();
    return out;
  };

  const tree = group(parse(html), false);

  return {
    segments,
    rebuild(translations) {
      return serialize(tree, (id) => {
        const unit = units[id];
        const t = translations.get(id);
        return t && t.trim() ? unit.before + restore(t, unit.placeholders) + unit.after : unit.original;
      });
    },
  };
}
