/**
 * outbox 回放（M2 实现）：把 mail_ops 里的待处理操作按顺序应用到邮件服务器。
 * 当前为占位实现，M2 补全。
 */
export async function applyOutbox(accountId: string): Promise<void> {
  console.log(`[outbox] 账号 ${accountId} 暂无可回放操作（M2 实现）`);
}
