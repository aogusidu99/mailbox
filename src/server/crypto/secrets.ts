import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * 邮箱凭据（授权码 / OAuth refresh token）加密存储。
 *
 * 算法：AES-256-GCM。
 * 存储格式：`v1.<iv b64url>.<tag b64url>.<ciphertext b64url>`
 * 主密钥来自环境变量 APP_MASTER_KEY，见 deriveKey()。
 */

const VERSION = "v1";
const IV_BYTES = 12; // GCM 推荐 96-bit IV
const KEY_BYTES = 32;

/**
 * 把 APP_MASTER_KEY 规范化为 32 字节密钥：
 * - 64 位 hex → 直接解码
 * - 44 位 base64 → 直接解码
 * - 其他任意口令 → SHA-256 派生
 */
export function deriveKey(masterKey: string): Buffer {
  const trimmed = masterKey.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) {
    const b = Buffer.from(trimmed, "base64");
    if (b.length === KEY_BYTES) return b;
  }
  return createHash("sha256").update(trimmed, "utf8").digest();
}

/** 生成一个新的随机主密钥（hex，64 字符），供 setup 脚本使用。 */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString("hex");
}

export function encryptSecret(plain: string, masterKey: string): string {
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, b64url(iv), b64url(tag), b64url(ciphertext)].join(".");
}

export function decryptSecret(payload: string, masterKey: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("无法识别的密文格式");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = deriveKey(masterKey);
  const decipher = createDecipheriv("aes-256-gcm", key, fromB64url(ivB64));
  decipher.setAuthTag(fromB64url(tagB64));
  const plain = Buffer.concat([decipher.update(fromB64url(dataB64)), decipher.final()]);
  return plain.toString("utf8");
}

/** 便捷方法：加密任意 JSON 对象。 */
export function encryptJson(value: unknown, masterKey: string): string {
  return encryptSecret(JSON.stringify(value), masterKey);
}

export function decryptJson<T = unknown>(payload: string, masterKey: string): T {
  return JSON.parse(decryptSecret(payload, masterKey)) as T;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}
