import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * 应用登录密码哈希：Node 内置 scrypt，不引入第三方依赖。
 * 存储格式：`scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>`
 */

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const DEFAULTS = { N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p } = DEFAULTS;
  const hash = await scrypt(password, salt, KEYLEN, { N, r, p, maxmem: 256 * N * r });
  return ["scrypt", N, r, p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 256 * N * r });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
