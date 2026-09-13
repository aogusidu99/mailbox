import { NextResponse } from "next/server";
import { getDbHandle } from "@/db";
import { getWorkerStatus } from "@/server/jobs/worker";

/**
 * 健康检查：GET /api/health
 * 返回数据库类型、worker 状态；用于本地验证与部署探针。
 */
export async function GET() {
  try {
    const handle = await getDbHandle();
    return NextResponse.json({
      ok: true,
      db: handle.kind,
      worker: await getWorkerStatus(),
      time: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
