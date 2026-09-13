import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { aiAnnotations, mailAccounts, messages } from "@/db/schema";
import type { MessageListItem, ThreadGroup, ThreadListResponse, ThreadNode } from "@/lib/api-types";
import { effectiveDate, toListItem } from "./queries";

/**
 * 会话视图（threading）：把一个文件夹里的邮件按主题汇总成会话，并按 In-Reply-To / References
 * 头还原每封邮件的回复关系，组织成树状结构。
 *
 * 分组信号（并集）：相同 threadId（如 Gmail 线程）> 互相引用（References/In-Reply-To）> 归一化后的相同主题。
 * `buildThreads` 是纯函数，便于单测；`threadFolder` 负责取数与解析邮件头。
 */

const MAX_MESSAGES = 500;

/** 归一化主题：去掉 Re:/Fwd:/回复:/答复:/转发: 等前缀（可重复），用于按主题分组 */
export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? "")
    .replace(/^\s*((re|fwd?|fw|回复|回覆|答复|转发|轉發)(\[\d+\])?\s*[:：]\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 归一化 Message-ID：去掉尖括号与大小写，用于跨邮件匹配 */
function normId(id: string): string {
  return id.trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

/** 从 References / In-Reply-To 头里抽取所有 <id> */
export function parseRefs(value: string | string[] | undefined | null): string[] {
  if (!value) return [];
  const joined = Array.isArray(value) ? value.join(" ") : value;
  return joined.match(/<[^>]+>/g) ?? [];
}

export interface ThreadInputMsg {
  item: MessageListItem;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  threadId: string | null;
  dateMs: number;
}

/** 并查集 */
class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    while (this.parent.get(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    // 路径压缩
    let cur = x;
    while (this.parent.get(cur) && this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    if (!this.parent.has(a)) this.parent.set(a, a);
    if (!this.parent.has(b)) this.parent.set(b, b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
}

/** 把一批邮件汇总成会话并还原回复树（纯函数）。输入已按需过滤，顺序无所谓。 */
export function buildThreads(msgs: ThreadInputMsg[]): ThreadGroup[] {
  const uf = new UnionFind();
  const byMsgId = new Map<string, string>(); // 归一化 Message-ID → 本地邮件 id
  for (const m of msgs) {
    uf.add(m.item.id);
    if (m.messageId) byMsgId.set(normId(m.messageId), m.item.id);
  }

  // 1) 按引用关系合并
  for (const m of msgs) {
    for (const ref of [m.inReplyTo, ...m.references]) {
      if (!ref) continue;
      const target = byMsgId.get(normId(ref));
      if (target) uf.union(m.item.id, target);
    }
  }
  // 2) 按 threadId 合并
  const byThreadId = new Map<string, string>();
  for (const m of msgs) {
    if (!m.threadId) continue;
    const seen = byThreadId.get(m.threadId);
    if (seen) uf.union(m.item.id, seen);
    else byThreadId.set(m.threadId, m.item.id);
  }
  // 3) 按归一化主题合并
  const bySubject = new Map<string, string>();
  for (const m of msgs) {
    const key = normalizeSubject(m.item.subject);
    if (!key) continue;
    const seen = bySubject.get(key);
    if (seen) uf.union(m.item.id, seen);
    else bySubject.set(key, m.item.id);
  }

  // 收集分组
  const groups = new Map<string, ThreadInputMsg[]>();
  for (const m of msgs) {
    const root = uf.find(m.item.id);
    const arr = groups.get(root) ?? [];
    arr.push(m);
    groups.set(root, arr);
  }

  const result: ThreadGroup[] = [];
  for (const [key, members] of groups) {
    result.push(buildGroup(key, members));
  }
  // 会话按最新邮件时间倒序
  result.sort((a, b) => (b.lastDate ? Date.parse(b.lastDate) : 0) - (a.lastDate ? Date.parse(a.lastDate) : 0));
  return result;
}

function buildGroup(key: string, members: ThreadInputMsg[]): ThreadGroup {
  const byMsgId = new Map<string, string>();
  for (const m of members) if (m.messageId) byMsgId.set(normId(m.messageId), m.item.id);
  const byLocalId = new Map<string, ThreadInputMsg>(members.map((m) => [m.item.id, m]));

  // 父指针：优先 In-Reply-To，否则取 References 中最后一个在本组内的
  const parentOf = new Map<string, string | null>();
  for (const m of members) {
    let parent: string | null = null;
    if (m.inReplyTo) {
      const p = byMsgId.get(normId(m.inReplyTo));
      if (p && p !== m.item.id) parent = p;
    }
    if (!parent) {
      for (let i = m.references.length - 1; i >= 0; i--) {
        const p = byMsgId.get(normId(m.references[i]));
        if (p && p !== m.item.id) {
          parent = p;
          break;
        }
      }
    }
    parentOf.set(m.item.id, parent);
  }

  const childrenOf = new Map<string, string[]>();
  for (const m of members) {
    const p = parentOf.get(m.item.id) ?? null;
    if (p) (childrenOf.get(p) ?? childrenOf.set(p, []).get(p)!).push(m.item.id);
  }

  // 找根：无父的；并处理环（从根出发不可达的提升为根）
  const roots = members.filter((m) => !parentOf.get(m.item.id)).map((m) => m.item.id);
  const reachable = new Set<string>();
  const walk = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const c of childrenOf.get(id) ?? []) walk(c);
  };
  for (const r of roots) walk(r);
  for (const m of members) if (!reachable.has(m.item.id)) roots.push(m.item.id); // 环/孤儿兜底

  const dateAsc = (a: string, b: string) => (byLocalId.get(a)!.dateMs - byLocalId.get(b)!.dateMs);
  const build = (id: string, guard: Set<string>): ThreadNode => {
    guard.add(id);
    const kids = (childrenOf.get(id) ?? []).filter((c) => !guard.has(c)).sort(dateAsc);
    return { message: byLocalId.get(id)!.item, children: kids.map((c) => build(c, guard)) };
  };
  const guard = new Set<string>();
  const rootNodes = [...new Set(roots)].sort(dateAsc).map((r) => build(r, guard));

  // 聚合
  let unreadCount = 0;
  let flagged = false;
  let hasAttachments = false;
  let lastMs = 0;
  const participants: string[] = [];
  const seenP = new Set<string>();
  let baseSubjectMsg: ThreadInputMsg | null = null;
  for (const m of members) {
    if (!m.item.seen) unreadCount++;
    if (m.item.flagged) flagged = true;
    if (m.item.hasAttachments) hasAttachments = true;
    if (m.dateMs > lastMs) lastMs = m.dateMs;
    if (!baseSubjectMsg || m.dateMs < baseSubjectMsg.dateMs) baseSubjectMsg = m;
    const from = m.item.from[0];
    const name = from ? from.name || from.address : "";
    const pkey = (from?.address || name).toLowerCase();
    if (name && !seenP.has(pkey)) {
      seenP.add(pkey);
      participants.push(name);
    }
  }

  return {
    key,
    subject: baseSubjectMsg?.item.subject ?? null,
    messageCount: members.length,
    unreadCount,
    lastDate: lastMs ? new Date(lastMs).toISOString() : null,
    participants,
    flagged,
    hasAttachments,
    roots: rootNodes,
  };
}

export interface ThreadFolderParams {
  userId: string;
  accountId: string;
  folderId: string;
  q?: string | null;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  category?: string | null;
}

/** 取文件夹（最近 MAX_MESSAGES 封，应用同样的过滤）并汇总成会话。 */
export async function threadFolder(params: ThreadFolderParams): Promise<ThreadListResponse> {
  const db = await getDb();
  const account = await db.query.mailAccounts.findFirst({ where: and(eq(mailAccounts.id, params.accountId), eq(mailAccounts.userId, params.userId)) });
  if (!account) return { threads: [], total: 0, capped: false };

  const conds: SQL[] = [eq(messages.accountId, params.accountId), eq(messages.folderId, params.folderId)];
  if (params.unreadOnly) conds.push(eq(messages.seen, false));
  if (params.flaggedOnly) conds.push(eq(messages.flagged, true));
  if (params.q && params.q.trim()) {
    const term = `%${params.q.trim()}%`;
    conds.push(or(ilike(messages.subject, term), ilike(messages.snippet, term), sql`${messages.fromAddrs}::text ilike ${term}`, sql`${messages.toAddrs}::text ilike ${term}`) as SQL);
  }
  if (params.category) conds.push(eq(aiAnnotations.category, params.category));

  const rows = await db
    .select({ message: messages, ai: aiAnnotations, effectiveDate })
    .from(messages)
    .leftJoin(aiAnnotations, eq(aiAnnotations.messageId, messages.id))
    .where(and(...conds))
    .orderBy(desc(effectiveDate), desc(messages.id))
    .limit(MAX_MESSAGES + 1);

  const capped = rows.length > MAX_MESSAGES;
  const page = rows.slice(0, MAX_MESSAGES);

  const input: ThreadInputMsg[] = page.map((r) => {
    const item = toListItem({ ...r.message, effectiveDate: r.effectiveDate, ai: r.ai });
    const headers = r.message.headers ?? {};
    return {
      item,
      messageId: r.message.messageId,
      inReplyTo: parseRefs(headers["in-reply-to"])[0] ?? null,
      references: parseRefs(headers["references"]),
      threadId: r.message.threadId,
      dateMs: item.date ? Date.parse(item.date) : 0,
    };
  });

  return { threads: buildThreads(input), total: input.length, capped };
}
