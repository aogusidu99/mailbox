import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.APP_MASTER_KEY = "d".repeat(64);
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "password123";

import { createDbHandle, setDbHandleForTests, type DbHandle } from "@/db";
import { digestReports, users } from "@/db/schema";
import { markRestNone } from "@/server/ai/digest";
import { getGoogleStatus } from "@/server/google/connection";
import { stopBossForTests } from "@/server/jobs/boss";

/**
 * 摘要台「剩余全部标记无需处理」、Google 连接状态默认值。
 * （待办已改为写入 Google 任务，本地 listTodos 已移除。）
 */
describe("摘要台 / Google 连接", () => {
  let handle: DbHandle;
  let userId = "";

  beforeAll(async () => {
    handle = await createDbHandle({ pgliteDataDir: null });
    setDbHandleForTests(handle);
    const [user] = await handle.db.insert(users).values({ email: "t@example.com", passwordHash: "x" }).returning();
    userId = user.id;
  });

  afterAll(async () => {
    await stopBossForTests();
    setDbHandleForTests(undefined);
    await handle.close();
  });

  test("摘要台：剩余全部标记无需处理（done 保留，其余置 none）", async () => {
    const periodKey = "day:2026-09-15";
    await handle.db.insert(digestReports).values({
      userId,
      periodKey,
      kind: "day",
      fromTs: new Date("2026-09-15T00:00:00Z"),
      toTs: new Date("2026-09-16T00:00:00Z"),
      content: "x",
      plan: [
        { messageId: "a", action: "reply", reason: "需回复", status: "pending" },
        { messageId: "b", action: "archive", reason: "已归档", status: "done" },
        { messageId: "c", action: "flag", reason: "跟进", status: "pending" },
        { messageId: "d", action: "none", reason: "无需", status: "pending" },
      ],
      model: "fake",
    });

    const r = await markRestNone(userId, periodKey);
    expect(r.changed).toBe(2); // reply + flag（none 不计、done 不计）
    const byId = Object.fromEntries(r.plan.map((d) => [d.messageId, d]));
    expect(byId.a.action).toBe("none");
    expect(byId.c.action).toBe("none");
    expect(byId.b.action).toBe("archive"); // done 保留原样
    expect(byId.b.status).toBe("done");
  });

  test("Google 连接状态：未连接时全 false", async () => {
    const status = await getGoogleStatus(userId);
    expect(status).toEqual({ connected: false, email: null, hasCalendar: false, hasTasks: false });
  });
});
