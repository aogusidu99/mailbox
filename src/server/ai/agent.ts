import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { aiAnnotations, folders, mailAccounts, messages } from "@/db/schema";
import { stripHtml } from "@/lib/quote";
import { recordUsage } from "./client";
import { embeddingConfigured, semanticSearch } from "./embeddings";
import { CATEGORY_LABELS, type Category } from "./prompts";
import type { AiChatMessage, AiToolDefinition } from "./providers/types";
import { loadAiSettings, resolveRole } from "./settings";

/**
 * 「和邮箱对话」Agent：模型通过工具检索邮件、读取正文，并把需要用户确认的操作以「建议」形式返回，
 * 由界面确认后再执行（不会自动改动邮件）。
 */

export interface ChatProposal {
  messageId: string;
  subject: string | null;
  action: "archive" | "trash" | "mark_read" | "flag" | "junk" | "label";
  value?: string;
  reason: string;
}

export interface ChatTrace {
  tool: string;
  input: unknown;
  summary: string;
}

export interface ChatTurnResult {
  reply: string;
  proposals: ChatProposal[];
  trace: ChatTrace[];
  model: string;
}

export type ChatHistoryItem = { role: "user" | "assistant"; content: string };

const TOOLS: AiToolDefinition[] = [
  {
    name: "search_mail",
    description: "按关键词在用户的邮件里搜索（匹配主题、发件人、摘要）。返回最多 limit 条最新结果。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词" },
        limit: { type: "integer", minimum: 1, maximum: 30, default: 10 },
        unreadOnly: { type: "boolean", default: false },
      },
      required: ["query"],
    },
  },
  {
    name: "semantic_search",
    description: "按语义（而不是关键词）搜索邮件，适合「和报销有关的邮件」这类模糊问题。需要已配置 embedding 模型。",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20, default: 8 } },
      required: ["query"],
    },
  },
  {
    name: "list_recent",
    description: "列出收件箱最近的邮件（含 AI 分类与摘要）。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        unreadOnly: { type: "boolean", default: false },
        category: { type: "string", description: "按 AI 分类过滤：important/todo/notification/billing/newsletter/promotion/social/personal/other" },
      },
    },
  },
  {
    name: "read_message",
    description: "读取一封邮件的完整正文（纯文本，最多 6000 字）。",
    inputSchema: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] },
  },
  {
    name: "propose_actions",
    description: "向用户建议对某些邮件执行操作（归档 / 删除 / 标为已读 / 星标 / 垃圾邮件 / 打标签）。不会直接执行，用户确认后才会执行。",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              messageId: { type: "string" },
              action: { type: "string", enum: ["archive", "trash", "mark_read", "flag", "junk", "label"] },
              value: { type: "string", description: "label 时为标签名" },
              reason: { type: "string" },
            },
            required: ["messageId", "action", "reason"],
          },
        },
      },
      required: ["actions"],
    },
  },
];

const proposalSchema = z.object({
  actions: z.array(
    z.object({
      messageId: z.string(),
      action: z.enum(["archive", "trash", "mark_read", "flag", "junk", "label"]),
      value: z.string().optional(),
      reason: z.string(),
    }),
  ),
});

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 16).replace("T", " ") : "";
}

function line(m: { id: string; subject: string | null; fromAddrs: Array<{ name?: string; address: string }>; date: Date | null; seen: boolean; snippet: string | null }, ai?: { category: string | null; priority: string | null; summary: string | null } | null): string {
  const from = m.fromAddrs[0] ? m.fromAddrs[0].name || m.fromAddrs[0].address : "";
  const cat = ai?.category ? `[${CATEGORY_LABELS[ai.category as Category] ?? ai.category}/${ai.priority ?? ""}]` : "";
  return `- id=${m.id} ${fmtDate(m.date)} ${m.seen ? "" : "(未读) "}${cat} ${from}：${m.subject ?? "(无主题)"} — ${ai?.summary ?? m.snippet ?? ""}`.slice(0, 400);
}

async function runTool(userId: string, accountIds: string[], name: string, input: Record<string, unknown>): Promise<{ result: string; summary: string; proposals?: ChatProposal[] }> {
  const db = await getDb();
  switch (name) {
    case "search_mail": {
      const q = String(input.query ?? "").trim();
      const limit = Math.min(Number(input.limit ?? 10), 30);
      if (!q) return { result: "缺少 query", summary: "缺少关键词" };
      const term = `%${q}%`;
      const conds: SQL[] = [inArray(messages.accountId, accountIds)];
      if (input.unreadOnly) conds.push(eq(messages.seen, false));
      conds.push(or(ilike(messages.subject, term), ilike(messages.snippet, term), sql`${messages.fromAddrs}::text ilike ${term}`) as SQL);
      const rows = await db
        .select({ message: messages, ai: aiAnnotations })
        .from(messages)
        .leftJoin(aiAnnotations, eq(aiAnnotations.messageId, messages.id))
        .where(and(...conds))
        .orderBy(desc(messages.date))
        .limit(limit);
      return { result: rows.length ? rows.map((r) => line(r.message, r.ai)).join("\n") : "没有找到匹配的邮件", summary: `搜索「${q}」：${rows.length} 条` };
    }
    case "semantic_search": {
      const q = String(input.query ?? "").trim();
      const settings = await loadAiSettings(userId);
      if (!embeddingConfigured(settings)) return { result: "未配置 embedding 模型，请改用 search_mail", summary: "语义搜索不可用" };
      const hits = await semanticSearch(userId, q, { limit: Math.min(Number(input.limit ?? 8), 20) });
      return {
        result: hits.length ? hits.map((h) => `- id=${h.messageId} ${h.date?.slice(0, 10) ?? ""} ${h.from}：${h.subject ?? "(无主题)"} — ${h.snippet ?? ""}（相似度 ${h.score}）`).join("\n") : "没有相似的邮件",
        summary: `语义搜索「${q}」：${hits.length} 条`,
      };
    }
    case "list_recent": {
      const limit = Math.min(Number(input.limit ?? 20), 50);
      const inboxes = await db.query.folders.findMany({ where: and(inArray(folders.accountId, accountIds), eq(folders.role, "inbox")) });
      if (inboxes.length === 0) return { result: "还没有同步任何收件箱", summary: "无收件箱" };
      const conds: SQL[] = [inArray(messages.folderId, inboxes.map((f) => f.id))];
      if (input.unreadOnly) conds.push(eq(messages.seen, false));
      if (typeof input.category === "string" && input.category) conds.push(eq(aiAnnotations.category, input.category));
      const rows = await db
        .select({ message: messages, ai: aiAnnotations })
        .from(messages)
        .leftJoin(aiAnnotations, eq(aiAnnotations.messageId, messages.id))
        .where(and(...conds))
        .orderBy(desc(messages.date))
        .limit(limit);
      return { result: rows.length ? rows.map((r) => line(r.message, r.ai)).join("\n") : "收件箱是空的", summary: `最近 ${rows.length} 封` };
    }
    case "read_message": {
      const id = String(input.messageId ?? "");
      const m = await db.query.messages.findFirst({ where: and(eq(messages.id, id), inArray(messages.accountId, accountIds)) });
      if (!m) return { result: "邮件不存在", summary: "邮件不存在" };
      if (!m.bodyFetchedAt) {
        const { ensureMessageBody } = await import("@/server/sync/engine");
        await ensureMessageBody(id).catch(() => undefined);
      }
      const fresh = (await db.query.messages.findFirst({ where: eq(messages.id, id) })) ?? m;
      const body = (fresh.textBody?.trim() || (fresh.htmlBody ? stripHtml(fresh.htmlBody, 6000) : "") || fresh.snippet || "").slice(0, 6000);
      const from = fresh.fromAddrs.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
      return { result: `发件人：${from}\n日期：${fmtDate(fresh.date)}\n主题：${fresh.subject ?? ""}\n\n${body}`, summary: `读取「${fresh.subject ?? ""}」` };
    }
    case "propose_actions": {
      const parsed = proposalSchema.safeParse(input);
      if (!parsed.success) return { result: "参数不合法", summary: "建议格式错误" };
      const ids = parsed.data.actions.map((a) => a.messageId);
      const rows = ids.length ? await db.query.messages.findMany({ where: and(inArray(messages.id, ids), inArray(messages.accountId, accountIds)) }) : [];
      const byId = new Map(rows.map((m) => [m.id, m]));
      const proposals: ChatProposal[] = parsed.data.actions
        .filter((a) => byId.has(a.messageId))
        .map((a) => ({ messageId: a.messageId, subject: byId.get(a.messageId)!.subject, action: a.action, value: a.value, reason: a.reason }));
      return { result: `已向用户展示 ${proposals.length} 条操作建议，等待用户确认。请在回复里简要说明这些建议。`, summary: `建议 ${proposals.length} 项操作`, proposals };
    }
    default:
      return { result: `未知工具 ${name}`, summary: "未知工具" };
  }
}

const MAX_ITERATIONS = 6;

export async function chatTurn(userId: string, history: ChatHistoryItem[], userMessage: string): Promise<ChatTurnResult> {
  const db = await getDb();
  const settings = await loadAiSettings(userId);
  const resolved = resolveRole(settings, "chat");
  if (!resolved.provider.chatWithTools) throw new Error(`${resolved.provider.name} 不支持工具调用，请为「和邮箱对话」等级选择其它厂商`);
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  const accountIds = accounts.map((a) => a.id);

  const system = [
    "你是用户的邮箱助理，帮用户查找、理解和整理邮件。",
    `今天是 ${new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}。`,
    `用户的邮箱：${accounts.map((a) => a.email).join("、") || "（还没有添加邮箱）"}。`,
    "规则：",
    "- 回答前先用工具查邮件，不要凭空猜测；引用邮件时写出主题和发件人。",
    "- 需要对邮件做归档、删除、标记等操作时，必须用 propose_actions 提出建议，由用户确认，不要声称已经执行。",
    "- 用中文回答，简洁、分点；找不到就直说。",
  ].join("\n");

  const messagesForModel: AiChatMessage[] = [...history.slice(-20).map((h) => ({ role: h.role, content: h.content })), { role: "user", content: userMessage }];
  const trace: ChatTrace[] = [];
  const proposals: ChatProposal[] = [];
  let reply = "";
  let modelUsed = resolved.model;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await resolved.provider.chatWithTools({
      model: resolved.model,
      apiKey: resolved.apiKey,
      baseUrl: resolved.provider.baseUrl,
      system,
      messages: messagesForModel,
      tools: TOOLS,
      effort: resolved.effort,
    });
    modelUsed = res.model;
    await recordUsage({ userId, role: "chat", providerId: resolved.providerId, model: res.model, usage: res.usage });
    if (res.finishReason === "refusal") throw new Error("模型拒绝了该请求");
    if (res.toolCalls.length === 0) {
      reply = res.text;
      break;
    }
    messagesForModel.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      const input = (call.input && typeof call.input === "object" ? call.input : {}) as Record<string, unknown>;
      let out: Awaited<ReturnType<typeof runTool>>;
      try {
        out = await runTool(userId, accountIds, call.name, input);
      } catch (err) {
        out = { result: `工具执行失败：${err instanceof Error ? err.message : String(err)}`, summary: "工具失败" };
      }
      if (out.proposals) proposals.push(...out.proposals);
      trace.push({ tool: call.name, input, summary: out.summary });
      messagesForModel.push({ role: "tool", toolCallId: call.id, name: call.name, content: out.result });
    }
    if (i === MAX_ITERATIONS - 1) reply = res.text || "（已达到工具调用上限，请把问题拆小一点再试）";
  }
  return { reply: reply.trim(), proposals, trace, model: modelUsed };
}
