import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "@/server/auth/password";

describe("password (scrypt)", () => {
  test("正确密码校验通过", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  test("错误密码校验失败", async () => {
    const hash = await hashPassword("right");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  test("格式非法的哈希返回 false 而不是抛错", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt$abc$8$1$salt$hash")).toBe(false);
  });
});
