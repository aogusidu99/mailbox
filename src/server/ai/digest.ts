import { and, desc, eq, gte, inArray, isNull, lt, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { aiSettings, aiAnnotations, digestReports, folders, mailAccounts, messages, type AiSettingsData, type DigestDisposition } from "@/db/schema";
import { deleteMessages, markMessages, moveMessages, setGmailLabels } from "@/server/mail/ops";
import { runRole } from "./client";
import { loadAiSettings } from "./settings";
import {
  CATEGORY_LABELS,
  DIGEST_PLAN_SYSTEM,
  DIGEST_REPLAN_SYSTEM,
  DIGEST_SYSTEM,
  digestDispositionSchema,
  type Category,
} from "./prompts";

/**
 * 摘要报告：把某个时间段（当天/本周/本月/自上次以来/自定义）内经过 AI 分析的邮件，
 * 汇总成一段 Markdown 概览 + 一份可执行的「处理意见」清单（disposition plan）。
 *
 * - 概览用 summary 等级的文本调用生成（与旧版 dailyDigest 一致，便于测试）；
 * - 处理意见用 summary 等级的 JSON 结构化调用生成，可用自然语言二次调整（replan），确认后批量执行。
 */

export type DigestKind = "day" | "week" | "month" | "since" | "custom";

export interface DigestItem {
  messageId: string;
  accountId: string;
  folderId: string;
  subject: string | null;
  from: string;
  date: string | null;
  category: string | null;
  categoryLabel: string;
  priority: string | null;
  summary: string | null;
  actionItems: Array<{ title: string; dueAt?: string }>;
  needsReply: boolean;
}

export interface ResolvedRange {
  kind: DigestKind;
  fromTs: Date;
  toTs: Date;
  periodKey: string;
  label: string;
}

export interface DigestResult {
  range: ResolvedRange;
  items: DigestItem[];
  content: string | null;
  plan: DigestDisposition[];
  model: string | null;
  cached: boolean;
}

// ---------- 时间段解析 ----------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 本地日期 YYYY-MM-DD */
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayKey(): string {
  return dateKey(new Date());
}

function startOfLocalDay(day: string): Date {
  return new Date(`${day}T00:00:00`);
}

/** 给定日期所在周的周一 00:00（本地时区） */
function startOfWeek(ref: Date): Date {
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const dow = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - dow);
  return d;
}

export interface RangeOptions {
  /** day/week/month 的参照日期（YYYY-MM-DD），默认今天 */
  day?: string;
  /** custom 的起止日期（YYYY-MM-DD，含首尾两天） */
  from?: string;
  to?: string;
}

/** 「自上次以来」的起点：用户最近一次非 since 报告的结束时间；没有则回退到 24 小时前 */
async function lastReportBoundary(userId: string): Promise<Date | null> {
  const db = await getDb();
  const row = await db.query.digestReports.findFirst({
    where: and(eq(digestReports.userId, userId), ne(digestReports.kind, "since")),
    orderBy: [desc(digestReports.toTs)],
  });
  return row?.toTs ?? null;
}

export async function resolveRange(userId: string, kind: DigestKind, opts: RangeOptions = {}): Promise<ResolvedRange> {
  if (kind === "day") {
    const day = opts.day && /^\d{4}-\d{2}-\d{2}$/.test(opts.day) ? opts.day : todayKey();
    const fromTs = startOfLocalDay(day);
    return { kind, fromTs, toTs: new Date(fromTs.getTime() + 86_400_000), periodKey: `day:${day}`, label: day };
  }
  if (kind === "week") {
    const ref = opts.day && /^\d{4}-\d{2}-\d{2}$/.test(opts.day) ? startOfLocalDay(opts.day) : new Date();
    const fromTs = startOfWeek(ref);
    const toTs = new Date(fromTs.getTime() + 7 * 86_400_000);
    const lastDay = new Date(toTs.getTime() - 86_400_000);
    return { kind, fromTs, toTs, periodKey: `week:${dateKey(fromTs)}`, label: `${dateKey(fromTs)} ~ ${dateKey(lastDay)}` };
  }
  if (kind === "month") {
    const ref = opts.day && /^\d{4}-\d{2}-\d{2}$/.test(opts.day) ? startOfLocalDay(opts.day) : new Date();
    const fromTs = new Date(ref.getFullYear(), ref.getMonth(), 1);
    const toTs = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
    return { kind, fromTs, toTs, periodKey: `month:${fromTs.getFullYear()}-${pad(fromTs.getMonth() + 1)}`, label: `${fromTs.getFullYear()}-${pad(fromTs.getMonth() + 1)}` };
  }
  if (kind === "since") {
    const boundary = (await lastReportBoundary(userId)) ?? new Date(Date.now() - 86_400_000);
    const toTs = new Date();
    return { kind, fromTs: boundary, toTs, periodKey: `since:${boundary.toISOString()}`, label: `自 ${dateKey(boundary)} 起` };
  }
  // custom
  const from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : todayKey();
  const to = opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : from;
  const fromTs = startOfLocalDay(from);
  const toTs = new Date(startOfLocalDay(to).getTime() + 86_400_000); // 含 to 当天
  return { kind, fromTs, toTs, periodKey: `custom:${from}..${to}`, label: `${from} ~ ${to}` };
}

// ---------- 邮件清单 ----------

const PRIORITY_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 };

export async function digestItemsInRange(userId: string, fromTs: Date, toTs: Date): Promise<DigestItem[]> {
  const db = await getDb();
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  if (accounts.length === 0) return [];
  const rows = await db
    .select({ message: messages, ai: aiAnnotations })
    .from(messages)
    .innerJoin(aiAnnotations, eq(aiAnnotations.messageId, messages.id))
    .where(and(inArray(messages.accountId, accounts.map((a) => a.id)), gte(messages.date, fromTs), lt(messages.date, toTs)))
    .orderBy(messages.date);
  return rows
    .map(({ message: m, ai }) => ({
      messageId: m.id,
      accountId: m.accountId,
      folderId: m.folderId,
      subject: m.subject,
      from: m.fromAddrs[0] ? m.fromAddrs[0].name || m.fromAddrs[0].address : "",
      date: m.date ? m.date.toISOString() : null,
      category: ai.category,
      categoryLabel: CATEGORY_LABELS[(ai.category ?? "other") as Category] ?? ai.category ?? "其他",
      priority: ai.priority,
      summary: ai.summary,
      actionItems: ai.actionItems,
      needsReply: (ai.reason ?? "").includes("需要回复"),
    }))
    .sort((a, b) => (PRIORITY_ORDER[a.priority ?? "normal"] ?? 1) - (PRIORITY_ORDER[b.priority ?? "normal"] ?? 1));
}

/** 把清单压成给模型的文本 */
function itemsToPromptList(items: DigestItem[]): string {
  return items
    .map(
      (i, idx) =>
        `${idx + 1}. id=${i.messageId} [${i.categoryLabel}/${i.priority}${i.needsReply ? "/需回复" : ""}] ${i.from}：${i.subject ?? "(无主题)"} — ${i.summary ?? ""}${
          i.actionItems.length ? ` 待办：${i.actionItems.map((a) => `${a.title}${a.dueAt ? `（${a.dueAt}）` : ""}`).join("；")}` : ""
        }`,
    )
    .join("\n");
}

// ---------- 生成 ----------

async function generateSummaryText(userId: string, range: ResolvedRange, items: DigestItem[]): Promise<{ text: string; model: string }> {
  const r = await runRole({
    userId,
    role: "summary",
    maxTokens: 2048,
    messages: [
      { role: "system", content: DIGEST_SYSTEM },
      { role: "user", content: `时间段：${range.label}（共 ${items.length} 封）。请据此把标题与措辞调整为对应的「当天/本周/本月」摘要：\n${itemsToPromptList(items)}` },
    ],
  });
  return { text: r.text.trim(), model: r.model };
}

async function generatePlan(userId: string, items: DigestItem[]): Promise<{ dispositions: DigestDisposition[]; model: string }> {
  const r = await runRole({
    userId,
    role: "summary",
    maxTokens: 4096,
    schema: digestDispositionSchema,
    schemaName: "digest_plan",
    messages: [
      { role: "system", content: DIGEST_PLAN_SYSTEM },
      { role: "user", content: `请为下面 ${items.length} 封邮件各给一条处理意见：\n${itemsToPromptList(items)}` },
    ],
  });
  return { dispositions: normalizePlan(r.json, items), model: r.model };
}

/** 只保留清单里真实存在的邮件；补默认状态 */
function normalizePlan(json: unknown, items: DigestItem[]): DigestDisposition[] {
  const valid = new Set(items.map((i) => i.messageId));
  const list = (json as { dispositions?: Array<Record<string, unknown>> } | undefined)?.dispositions ?? [];
  const seen = new Set<string>();
  const out: DigestDisposition[] = [];
  for (const d of list) {
    const messageId = String(d.messageId ?? "");
    if (!valid.has(messageId) || seen.has(messageId)) continue;
    seen.add(messageId);
    out.push({
      messageId,
      action: (d.action as DigestDisposition["action"]) ?? "none",
      value: d.value ? String(d.value) : undefined,
      reason: String(d.reason ?? ""),
      replyPoints: d.replyPoints ? String(d.replyPoints) : undefined,
      status: "pending",
    });
  }
  return out;
}

async function upsert(userId: string, range: ResolvedRange, content: string | null, plan: DigestDisposition[], model: string | null): Promise<void> {
  const db = await getDb();
  await db
    .insert(digestReports)
    .values({ userId, periodKey: range.periodKey, kind: range.kind, fromTs: range.fromTs, toTs: range.toTs, content, plan, model })
    .onConflictDoUpdate({
      target: [digestReports.userId, digestReports.periodKey],
      set: { kind: range.kind, fromTs: range.fromTs, toTs: range.toTs, content, plan, model, updatedAt: new Date() },
    });
}

/**
 * 按需分析：把时间段内收件箱中「还没分析过」的邮件即时跑一遍 triage。
 * cap 为上限（前台「生成」按钮传一个数防超时）；不传 = 分析全部（每日定时摘要后台跑，不设限）。
 */
async function analyzeRangeInbox(userId: string, fromTs: Date, toTs: Date, cap?: number): Promise<number> {
  const db = await getDb();
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  if (accounts.length === 0) return 0;
  const inboxes = await db.query.folders.findMany({ where: and(inArray(folders.accountId, accounts.map((a) => a.id)), eq(folders.role, "inbox")) });
  if (inboxes.length === 0) return 0;
  const q = db
    .select({ id: messages.id, accountId: messages.accountId })
    .from(messages)
    .leftJoin(aiAnnotations, eq(aiAnnotations.messageId, messages.id))
    .where(and(inArray(messages.folderId, inboxes.map((f) => f.id)), gte(messages.date, fromTs), lt(messages.date, toTs), isNull(aiAnnotations.id)))
    .orderBy(desc(messages.date));
  const rows = cap && cap > 0 ? await q.limit(cap) : await q;
  const { triageMessage } = await import("./triage");
  let n = 0;
  for (const r of rows) {
    // force：无视账号「AI 处理」开关和范围限制，直接分析（错误会向上抛出，便于提示未配置 Key 等）
    await triageMessage(r.accountId, r.id, { force: true });
    n += 1;
  }
  return n;
}

export interface GenerateDigestOptions extends RangeOptions {
  refresh?: boolean;
  /** 是否生成「处理意见」（页面 true；旧版 dailyDigest 只要概览时 false） */
  withPlan?: boolean;
  /** 生成前先即时分析该时间段内未分析的收件箱邮件（页面「生成」按钮用） */
  analyze?: boolean;
  /** 即时分析的封数上限；不传 = 全部（每日定时摘要用）。前台按钮传一个数防超时。 */
  analyzeCap?: number;
}

export async function generateDigest(userId: string, kind: DigestKind, opts: GenerateDigestOptions = {}): Promise<DigestResult> {
  const db = await getDb();
  const range = await resolveRange(userId, kind, opts);
  if (opts.analyze) await analyzeRangeInbox(userId, range.fromTs, range.toTs, opts.analyzeCap);
  const items = await digestItemsInRange(userId, range.fromTs, range.toTs);

  const cached = await db.query.digestReports.findFirst({ where: and(eq(digestReports.userId, userId), eq(digestReports.periodKey, range.periodKey)) });
  const wantPlan = opts.withPlan ?? false;
  const planReady = !wantPlan || (cached?.plan?.length ?? 0) > 0 || items.length === 0;
  if (!opts.refresh && cached && cached.content !== null && planReady) {
    return { range, items, content: cached.content, plan: cached.plan ?? [], model: cached.model, cached: true };
  }

  if (items.length === 0) {
    await upsert(userId, range, null, [], null);
    return { range, items, content: null, plan: [], model: null, cached: false };
  }

  const summary = await generateSummaryText(userId, range, items);
  const plan = wantPlan ? (await generatePlan(userId, items)).dispositions : (cached?.plan ?? []);
  await upsert(userId, range, summary.text, plan, summary.model);
  return { range, items, content: summary.text, plan, model: summary.model, cached: false };
}

/** 只读加载：解析时间段 + 邮件清单 + 已缓存的概览/处理意见，不触发任何 AI 调用（页面初次渲染用） */
export async function loadDigest(userId: string, kind: DigestKind, opts: RangeOptions = {}): Promise<DigestResult> {
  const db = await getDb();
  const range = await resolveRange(userId, kind, opts);
  const items = await digestItemsInRange(userId, range.fromTs, range.toTs);
  const cached = await db.query.digestReports.findFirst({ where: and(eq(digestReports.userId, userId), eq(digestReports.periodKey, range.periodKey)) });
  return { range, items, content: cached?.content ?? null, plan: cached?.plan ?? [], model: cached?.model ?? null, cached: Boolean(cached) };
}

/** 手动调整单封邮件的处理意见（动作 / 标签值）；不在清单里则新增一条 */
export async function updateDisposition(
  userId: string,
  periodKey: string,
  messageId: string,
  patch: { action?: DigestDisposition["action"]; value?: string | null; reason?: string },
): Promise<void> {
  const db = await getDb();
  const report = await db.query.digestReports.findFirst({ where: and(eq(digestReports.userId, userId), eq(digestReports.periodKey, periodKey)) });
  if (!report) throw new Error("摘要不存在");
  const plan = [...(report.plan ?? [])];
  const idx = plan.findIndex((d) => d.messageId === messageId);
  if (idx >= 0) {
    plan[idx] = {
      ...plan[idx],
      ...(patch.action ? { action: patch.action } : {}),
      ...(patch.value !== undefined ? { value: patch.value ?? undefined } : {}),
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
      status: "pending",
    };
  } else {
    plan.push({ messageId, action: patch.action ?? "none", value: patch.value ?? undefined, reason: patch.reason ?? "手动设置", status: "pending" });
  }
  await db.update(digestReports).set({ plan, updatedAt: new Date() }).where(eq(digestReports.id, report.id));
}

/** 旧接口（按天，只要概览），保留给测试与简单调用 */
export async function dailyDigest(userId: string, day: string, opts: { refresh?: boolean } = {}): Promise<{ items: DigestItem[]; content: string | null; model?: string; cached: boolean }> {
  const r = await generateDigest(userId, "day", { day, refresh: opts.refresh, withPlan: false });
  return { items: r.items, content: r.content, model: r.model ?? undefined, cached: r.cached };
}

// ---------- 自然语言调整处理意见 ----------

export async function replanDigest(userId: string, periodKey: string, instruction: string): Promise<DigestResult> {
  const db = await getDb();
  const report = await db.query.digestReports.findFirst({ where: and(eq(digestReports.userId, userId), eq(digestReports.periodKey, periodKey)) });
  if (!report) throw new Error("摘要不存在，请先生成");
  const items = await digestItemsInRange(userId, report.fromTs, report.toTs);
  if (items.length === 0) throw new Error("这个时间段没有可处理的邮件");

  const current = (report.plan ?? [])
    .map((d) => `- id=${d.messageId} 当前意见：${d.action}${d.value ? `(${d.value})` : ""} — ${d.reason}`)
    .join("\n");
  const r = await runRole({
    userId,
    role: "summary",
    maxTokens: 4096,
    schema: digestDispositionSchema,
    schemaName: "digest_replan",
    messages: [
      { role: "system", content: DIGEST_REPLAN_SYSTEM },
      {
        role: "user",
        content: `邮件清单：\n${itemsToPromptList(items)}\n\n当前处理意见：\n${current || "（尚无）"}\n\n我的调整要求：${instruction.trim()}`,
      },
    ],
  });
  // 保留已处理状态：只对仍是 pending 的项应用新意见
  const prevStatus = new Map((report.plan ?? []).map((d) => [d.messageId, d.status]));
  const next = normalizePlan(r.json, items).map((d) => (prevStatus.get(d.messageId) === "done" ? { ...d, status: "done" as const } : d));
  await db.update(digestReports).set({ plan: next, model: r.model, updatedAt: new Date() }).where(eq(digestReports.id, report.id));
  return { range: { kind: report.kind as DigestKind, fromTs: report.fromTs, toTs: report.toTs, periodKey, label: periodKey }, items, content: report.content, plan: next, model: r.model, cached: false };
}

// ---------- 确认后自动执行 ----------

export interface ExecuteResult {
  done: string[];
  skipped: string[];
  failed: Array<{ messageId: string; error: string }>;
}

/** 对选中的邮件按其处理意见执行（reply 交给回复流程，不在这里自动发送） */
export async function executeDispositions(userId: string, periodKey: string, messageIds: string[]): Promise<ExecuteResult> {
  const db = await getDb();
  const report = await db.query.digestReports.findFirst({ where: and(eq(digestReports.userId, userId), eq(digestReports.periodKey, periodKey)) });
  if (!report) throw new Error("摘要不存在");
  const selected = new Set(messageIds);
  const plan = report.plan ?? [];
  const result: ExecuteResult = { done: [], skipped: [], failed: [] };
  const statusById = new Map(plan.map((d) => [d.messageId, d.status] as const));

  for (const d of plan) {
    if (!selected.has(d.messageId) || d.status === "done") continue;
    try {
      switch (d.action) {
        case "archive":
          await moveMessages(userId, [d.messageId], { role: "archive" });
          break;
        case "trash":
          await deleteMessages(userId, [d.messageId]);
          break;
        case "junk":
          await moveMessages(userId, [d.messageId], { role: "junk" });
          break;
        case "mark_read":
          await markMessages(userId, [d.messageId], { seen: true });
          break;
        case "flag":
        case "todo": // 记为待办：先加星标，保留在收件箱，待办面板会汇总其 actionItems
          await markMessages(userId, [d.messageId], { flagged: true });
          break;
        case "label": {
          const [row] = await loadOwnedForLabel(userId, d.messageId);
          if (row) await setGmailLabels(row.accountId, row.folderPath, [row.uid], [d.value || "AI/Other"]);
          break;
        }
        case "unsubscribe": {
          const { unsubscribe } = await import("@/server/mail/unsubscribe");
          await unsubscribe(userId, d.messageId);
          break;
        }
        case "reply":
        case "none":
        default:
          result.skipped.push(d.messageId);
          statusById.set(d.messageId, d.status);
          continue;
      }
      result.done.push(d.messageId);
      statusById.set(d.messageId, "done");
    } catch (err) {
      result.failed.push({ messageId: d.messageId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const nextPlan = plan.map((d) => ({ ...d, status: statusById.get(d.messageId) ?? d.status }));
  await db.update(digestReports).set({ plan: nextPlan, updatedAt: new Date() }).where(eq(digestReports.id, report.id));
  return result;
}

/** 标记某封邮件的处理意见状态（如 reply 发送后置为 done） */
export async function markDispositionStatus(userId: string, periodKey: string, messageId: string, status: "pending" | "done" | "skipped"): Promise<void> {
  const db = await getDb();
  const report = await db.query.digestReports.findFirst({ where: and(eq(digestReports.userId, userId), eq(digestReports.periodKey, periodKey)) });
  if (!report) return;
  const plan = (report.plan ?? []).map((d) => (d.messageId === messageId ? { ...d, status } : d));
  await db.update(digestReports).set({ plan, updatedAt: new Date() }).where(eq(digestReports.id, report.id));
}

async function loadOwnedForLabel(userId: string, messageId: string): Promise<Array<{ accountId: string; folderPath: string; uid: number }>> {
  const { loadOwnedMessages } = await import("@/server/mail/ops");
  const rows = await loadOwnedMessages(userId, [messageId]);
  return rows.map((r) => ({ accountId: r.account.id, folderPath: r.folder.path, uid: r.message.uid }));
}

// ---------- 每日定时摘要（worker 调用） ----------

/** 前一天的本地日期 YYYY-MM-DD */
function yesterdayKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dateKey(d);
}

/** 把每日摘要配置写回 ai_settings（用于记录 lastRunDate，防同一天重复运行） */
async function saveDailyDigestState(userId: string, dailyDigest: AiSettingsData["dailyDigest"]): Promise<void> {
  const db = await getDb();
  const row = await db.query.aiSettings.findFirst({ where: eq(aiSettings.userId, userId) });
  if (!row) return;
  await db.update(aiSettings).set({ data: { ...row.data, dailyDigest } }).where(eq(aiSettings.userId, userId));
}

/**
 * worker 每隔几分钟调用一次：到达配置的小时、且今天还没跑过，就为每个开启的用户
 * 分析前一天的收件箱邮件、生成摘要与处理意见，并按需把摘要发一封邮件到自己邮箱。
 */
export async function runDailyDigests(): Promise<void> {
  const db = await getDb();
  const hour = new Date().getHours();
  const today = todayKey();
  const allUsers = await db.query.users.findMany();
  for (const user of allUsers) {
    let cfg: AiSettingsData["dailyDigest"];
    try {
      cfg = (await loadAiSettings(user.id)).data.dailyDigest;
    } catch {
      continue;
    }
    if (!cfg?.enabled || hour !== cfg.hour || cfg.lastRunDate === today) continue;
    // 先占位（防止同一小时内多次 tick、或生成较慢时重复运行）
    await saveDailyDigestState(user.id, { ...cfg, lastRunDate: today });
    try {
      const day = yesterdayKey();
      const result = await generateDigest(user.id, "day", { day, withPlan: true, analyze: true, refresh: true });
      console.log(`[digest] ${user.email} 每日摘要（${day}）已生成，${result.items.length} 封`);
      if (cfg.email && result.content) await emailDigestToSelf(user.id, day, result);
    } catch (err) {
      console.error(`[digest] ${user.email} 每日摘要失败:`, err instanceof Error ? err.message : err);
    }
  }
}

/** 把摘要作为一封邮件发到用户自己的邮箱（用最早添加的账号收发） */
async function emailDigestToSelf(userId: string, day: string, result: DigestResult): Promise<void> {
  const db = await getDb();
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId), orderBy: (t, { asc }) => [asc(t.createdAt)] });
  const account = accounts[0];
  if (!account) return;
  const lines: string[] = [result.content ?? "（今天没有可摘要的邮件）"];
  const planById = new Map(result.plan.map((p) => [p.messageId, p]));
  const needAction = result.items.filter((i) => {
    const d = planById.get(i.messageId);
    return i.needsReply || i.priority === "high" || (d && (d.action === "reply" || d.action === "flag" || d.action === "todo"));
  });
  if (needAction.length) {
    lines.push("", `—— 需要处理 / 需回复（${needAction.length}）——`);
    for (const i of needAction) lines.push(`· ${i.from}：${i.subject ?? "(无主题)"}${i.summary ? ` — ${i.summary}` : ""}`);
  }
  lines.push("", "（本邮件由 Mailbox 每日摘要自动发送）");
  const { sendMail } = await import("@/server/mail/send");
  await sendMail(userId, account.id, { to: account.email, subject: `每日邮件摘要 · ${day}`, text: lines.join("\n"), attachments: [] });
  console.log(`[digest] 每日摘要邮件已发送到 ${account.email}`);
}
