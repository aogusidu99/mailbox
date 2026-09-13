import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { aiAnnotations, folders, mailAccounts, messages } from "@/db/schema";
import { enqueueAiTriage } from "@/server/jobs/queues";
import { enqueueRawOperation } from "@/server/mail/ops";
import { publish } from "@/server/realtime/bus";
import { runRole } from "./client";
import { CATEGORY_LABEL_NAMES, messageToPromptText, PROMPT_VERSION, TRIAGE_SYSTEM, triageSchema, type TriageOutput } from "./prompts";
import { loadAiSettings } from "./settings";

/**
 * AI 分类 / 优先级 / 摘要（triage 等级），结果存 ai_annotations，并按设置写回服务器：
 * - Gmail：加标签 AI/<Category>（标签不存在时先创建）
 * - 其它 IMAP：可选复制到 AI/<Category> 文件夹（默认关闭）
 */

export async function triageMessage(accountId: string, messageId: string, opts: { force?: boolean } = {}): Promise<TriageOutput | null> {
  const db = await getDb();
  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message || message.accountId !== accountId) return null;
  const account = await db.query.mailAccounts.findFirst({ where: eq(mailAccounts.id, accountId) });
  if (!account) return null;
  if (!account.aiEnabled && !opts.force) return null;
  const folder = await db.query.folders.findFirst({ where: eq(folders.id, message.folderId) });
  if (!folder) return null;

  const settings = await loadAiSettings(account.userId);
  if (!opts.force && settings.data.autoTriageScope === "inbox" && folder.role !== "inbox") return null;

  const existing = await db.query.aiAnnotations.findFirst({ where: eq(aiAnnotations.messageId, messageId) });
  if (existing && !opts.force) return existing as unknown as TriageOutput;

  const result = await runRole<TriageOutput>({
    userId: account.userId,
    accountId,
    role: "triage",
    settings,
    schema: triageSchema,
    schemaName: "triage",
    maxTokens: 1024,
    messages: [
      { role: "system", content: TRIAGE_SYSTEM },
      { role: "user", content: messageToPromptText(message) },
    ],
  });
  const output = result.json;
  if (!output) throw new Error("AI 没有返回分类结果");

  await db
    .insert(aiAnnotations)
    .values({
      messageId,
      category: output.category,
      priority: output.priority,
      summary: output.summary,
      actionItems: output.actionItems.map((a) => ({ title: a.title, dueAt: a.dueAt ?? undefined })),
      reason: `${output.reason}${output.needsReply ? "（需要回复）" : ""}`,
      model: result.model,
      promptVersion: PROMPT_VERSION,
    })
    .onConflictDoUpdate({
      target: aiAnnotations.messageId,
      set: {
        category: output.category,
        priority: output.priority,
        summary: output.summary,
        actionItems: output.actionItems.map((a) => ({ title: a.title, dueAt: a.dueAt ?? undefined })),
        reason: `${output.reason}${output.needsReply ? "（需要回复）" : ""}`,
        model: result.model,
        promptVersion: PROMPT_VERSION,
        createdAt: new Date(),
      },
    });

  await writeBack(account.id, account.presetId === "gmail" || account.provider === "gmail", folder.path, message.uid, output, settings.data.writeBack).catch((err) =>
    console.warn("[ai] 分类写回失败:", err instanceof Error ? err.message : err),
  );

  publish({ type: "message", accountId, folderId: message.folderId, messageId });
  console.log(`[ai] ${account.email} 「${message.subject ?? ""}」→ ${output.category}/${output.priority}（${result.model}${result.fallbackFrom ? "，降级" : ""}）`);
  return output;
}

async function writeBack(accountId: string, isGmail: boolean, folderPath: string, uid: number, output: TriageOutput, mode: { gmailLabels: boolean; imapFolders: boolean }) {
  const label = CATEGORY_LABEL_NAMES[output.category];
  const db = await getDb();
  const known = await db.query.folders.findMany({ where: eq(folders.accountId, accountId) });
  if (isGmail && mode.gmailLabels) {
    // Gmail 里标签即文件夹：不存在就先创建
    if (!known.some((f) => f.path === label)) await enqueueRawOperation(accountId, { type: "create_folder", folder: label }, []);
    await enqueueRawOperation(accountId, { type: "set_labels", folder: folderPath, uids: [uid], add: [label] }, [folderPath]);
    return;
  }
  if (!isGmail && mode.imapFolders) {
    if (!known.some((f) => f.path === label)) await enqueueRawOperation(accountId, { type: "create_folder", folder: label }, []);
    await enqueueRawOperation(accountId, { type: "copy", folder: folderPath, uids: [uid], toFolder: label }, [label]);
  }
}

/** 对已有邮件回填分析：最近 limit 封没有标注且已拉取正文的收件箱邮件 */
export async function backfillTriage(userId: string, accountId: string | null, limit = 100): Promise<number> {
  const db = await getDb();
  const accounts = await db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) });
  let queued = 0;
  for (const account of accounts) {
    if (accountId && account.id !== accountId) continue;
    const inbox = await db.query.folders.findFirst({ where: and(eq(folders.accountId, account.id), eq(folders.role, "inbox")) });
    if (!inbox) continue;
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .leftJoin(aiAnnotations, eq(aiAnnotations.messageId, messages.id))
      .where(and(eq(messages.folderId, inbox.id), isNull(aiAnnotations.id)))
      .orderBy(desc(messages.date))
      .limit(limit);
    for (const r of rows) {
      await enqueueAiTriage(account.id, r.id);
      queued += 1;
    }
  }
  return queued;
}
