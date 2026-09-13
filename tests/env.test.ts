import { afterEach, describe, expect, test } from "bun:test";
import { getEnv, resetEnvCache } from "@/env";

const REQUIRED = {
  AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  APP_MASTER_KEY: "f".repeat(64),
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD: "password123",
};

describe("env", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    resetEnvCache();
  });

  test("缺少必填项时给出可读错误", () => {
    delete process.env.AUTH_SECRET;
    delete process.env.APP_MASTER_KEY;
    resetEnvCache();
    expect(() => getEnv()).toThrow(/AUTH_SECRET/);
  });

  test("合法配置解析并应用默认值", () => {
    Object.assign(process.env, REQUIRED);
    delete process.env.DATABASE_URL;
    delete process.env.WORKER_ENABLED;
    resetEnvCache();
    const env = getEnv();
    expect(env.PGLITE_DATA_DIR).toBe("./data/pglite");
    expect(env.WORKER_ENABLED).toBe(true);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  test("WORKER_ENABLED=false 解析为布尔 false", () => {
    Object.assign(process.env, REQUIRED, { WORKER_ENABLED: "false" });
    resetEnvCache();
    expect(getEnv().WORKER_ENABLED).toBe(false);
  });
});
