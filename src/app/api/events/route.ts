import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailAccounts } from "@/db/schema";
import { getSessionUser } from "@/server/auth/session";
import { subscribe } from "@/server/realtime/bus";

export const dynamic = "force-dynamic";

/**
 * SSE：把 worker 的同步事件推给浏览器，前端据此刷新列表与侧栏。
 * 只推送属于当前用户账号的事件。
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const db = await getDb();
  const owned = new Set(
    (await db.select({ id: mailAccounts.id }).from(mailAccounts).where(eq(mailAccounts.userId, user.id))).map((r) => r.id),
  );

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          /* 已关闭 */
        }
      };
      send({ type: "hello" });
      const unsubscribe = subscribe((event) => {
        if ("accountId" in event && !owned.has(event.accountId)) return;
        send(event);
      });
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          /* ignore */
        }
      }, 25_000);
      const close = () => {
        unsubscribe();
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };
      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
