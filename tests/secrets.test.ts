import { describe, expect, test } from "bun:test";
import {
  decryptJson,
  decryptSecret,
  deriveKey,
  encryptJson,
  encryptSecret,
  generateMasterKey,
} from "@/server/crypto/secrets";

describe("secrets (AES-256-GCM)", () => {
  const key = generateMasterKey();

  test("加密后可解密还原", () => {
    const payload = encryptSecret("授权码-abc123", key);
    expect(payload.startsWith("v1.")).toBe(true);
    expect(decryptSecret(payload, key)).toBe("授权码-abc123");
  });

  test("同一明文两次加密结果不同（随机 IV）", () => {
    expect(encryptSecret("x", key)).not.toBe(encryptSecret("x", key));
  });

  test("密文被篡改时解密失败", () => {
    const payload = encryptSecret("secret", key);
    const parts = payload.split(".");
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("AA") ? "BB" : "AA");
    expect(() => decryptSecret(parts.join("."), key)).toThrow();
  });

  test("错误的主密钥无法解密", () => {
    const payload = encryptSecret("secret", key);
    expect(() => decryptSecret(payload, generateMasterKey())).toThrow();
  });

  test("deriveKey 支持 hex / base64 / 任意口令", () => {
    expect(deriveKey("a".repeat(64)).length).toBe(32);
    expect(deriveKey(Buffer.alloc(32, 1).toString("base64")).length).toBe(32);
    expect(deriveKey("一个足够长的口令一个足够长的口令一个足够长的口令").length).toBe(32);
  });

  test("JSON 便捷方法", () => {
    const payload = encryptJson({ password: "p@ss", n: 1 }, key);
    expect(decryptJson<{ password: string; n: number }>(payload, key)).toEqual({ password: "p@ss", n: 1 });
  });
});
