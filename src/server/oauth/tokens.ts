import type { MailAccount } from "@/db/schema";
import type { StoredCredentials } from "@/server/providers/factory";

/**
 * OAuth2 access token 刷新（M5 实现 Gmail / Outlook 授权后补全）。
 * 目前直接返回已存凭据；接入 OAuth 后在这里按 expiresAt 刷新并写回数据库。
 */
export async function ensureFreshAccessToken(_account: MailAccount, creds: StoredCredentials): Promise<StoredCredentials> {
  return creds;
}
