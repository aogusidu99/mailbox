import { describe, expect, test } from "bun:test";
import type { MessageListItem } from "@/lib/api-types";
import { buildThreads, normalizeSubject, parseRefs, type ThreadInputMsg } from "@/server/mail/threading";

/**
 * 会话视图分组与回复树（纯函数 buildThreads）。
 */

let seq = 0;
function m(o: {
  id: string;
  subject: string | null;
  from?: string;
  seen?: boolean;
  flagged?: boolean;
  hasAttachments?: boolean;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
  dateMs: number;
}): ThreadInputMsg {
  const name = o.from ?? o.id;
  const item: MessageListItem = {
    id: o.id,
    accountId: "acc",
    folderId: "f",
    uid: ++seq,
    subject: o.subject,
    from: [{ name, address: `${name}@x.com` }],
    to: [],
    date: new Date(o.dateMs).toISOString(),
    snippet: null,
    seen: o.seen ?? true,
    flagged: o.flagged ?? false,
    answered: false,
    draft: false,
    hasAttachments: o.hasAttachments ?? false,
    threadId: o.threadId ?? null,
    bodyFetched: true,
    ai: null,
  };
  return { item, messageId: o.messageId ?? null, inReplyTo: o.inReplyTo ?? null, references: o.references ?? [], threadId: o.threadId ?? null, dateMs: o.dateMs };
}

describe("threading", () => {
  test("normalizeSubject 去掉各种回复/转发前缀", () => {
    expect(normalizeSubject("Re: Fwd: 回复: Hello")).toBe("hello");
    expect(normalizeSubject("RE[2]: 项目")).toBe("项目");
    expect(normalizeSubject("转发：周报")).toBe("周报");
    expect(normalizeSubject("普通主题")).toBe("普通主题");
    expect(normalizeSubject(null)).toBe("");
  });

  test("parseRefs 抽取所有 <id>", () => {
    expect(parseRefs("<a@x> <b@x>")).toEqual(["<a@x>", "<b@x>"]);
    expect(parseRefs(["<a@x>", "<b@x>"])).toEqual(["<a@x>", "<b@x>"]);
    expect(parseRefs(undefined)).toEqual([]);
  });

  test("按主题汇总 + 回复树 + 聚合", () => {
    const groups = buildThreads([
      m({ id: "a", subject: "Meeting", from: "Alice", messageId: "<a>", dateMs: 1000 }),
      m({ id: "b", subject: "Re: Meeting", from: "Bob", messageId: "<b>", inReplyTo: "<a>", dateMs: 2000 }),
      m({ id: "c", subject: "RE:  meeting", from: "Alice", messageId: "<c>", inReplyTo: "<b>", dateMs: 3000, seen: false, hasAttachments: true }),
      m({ id: "z", subject: "Lunch", from: "Carol", messageId: "<z>", dateMs: 1500 }),
    ]);
    expect(groups).toHaveLength(2);
    // 最新会话在前（Meeting 最后一封 3000 > Lunch 1500）
    const meeting = groups[0];
    expect(meeting.messageCount).toBe(3);
    expect(meeting.unreadCount).toBe(1);
    expect(meeting.hasAttachments).toBe(true);
    expect(meeting.lastDate).toBe(new Date(3000).toISOString());
    expect(meeting.participants).toEqual(["Alice", "Bob"]); // 去重，按出现顺序
    // 回复树：a → b → c
    expect(meeting.roots).toHaveLength(1);
    expect(meeting.roots[0].message.id).toBe("a");
    expect(meeting.roots[0].children[0].message.id).toBe("b");
    expect(meeting.roots[0].children[0].children[0].message.id).toBe("c");
    expect(groups[1].subject).toBe("Lunch");
  });

  test("即使主题不同，也能按 References 归到同一会话", () => {
    const groups = buildThreads([
      m({ id: "a", subject: "项目启动", messageId: "<a>", dateMs: 1000 }),
      m({ id: "d", subject: "完全不同的主题", messageId: "<d>", references: ["<a>", "<missing>"], dateMs: 2000 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].roots[0].message.id).toBe("a");
    expect(groups[0].roots[0].children.map((c) => c.message.id)).toEqual(["d"]);
  });

  test("相同 threadId 归为一组（即使无引用、主题不同）", () => {
    const groups = buildThreads([
      m({ id: "a", subject: "X", threadId: "T1", dateMs: 1000 }),
      m({ id: "b", subject: "Y", threadId: "T1", dateMs: 2000 }),
      m({ id: "c", subject: "Z", threadId: "T2", dateMs: 3000 }),
    ]);
    expect(groups).toHaveLength(2);
    const t1 = groups.find((g) => g.messageCount === 2)!;
    expect(new Set(collectIds(t1.roots))).toEqual(new Set(["a", "b"]));
  });
});

function collectIds(nodes: { message: { id: string }; children: unknown[] }[]): string[] {
  const out: string[] = [];
  const walk = (ns: { message: { id: string }; children: unknown[] }[]) => {
    for (const n of ns) {
      out.push(n.message.id);
      walk(n.children as typeof ns);
    }
  };
  walk(nodes);
  return out;
}
