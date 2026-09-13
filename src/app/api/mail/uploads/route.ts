import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { getSessionUser } from "@/server/auth/session";
import { UPLOAD_DIR, uploadPath } from "@/server/mail/compose";

export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;

/** POST /api/mail/uploads（multipart，字段 file）→ 临时附件 id */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "缺少文件" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "附件不能超过 25MB" }, { status: 413 });
  const id = randomUUID();
  mkdirSync(/*turbopackIgnore: true*/ UPLOAD_DIR, { recursive: true });
  writeFileSync(/*turbopackIgnore: true*/ uploadPath(id), Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ id, filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size });
}
