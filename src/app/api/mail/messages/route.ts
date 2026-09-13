import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { listMessages } from "@/server/mail/queries";

export const dynamic = "force-dynamic";

/** GET /api/mail/messages?accountId&folderId&cursor&q&unread=1&flagged=1&category= */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId");
  const folderId = sp.get("folderId");
  if (!accountId || !folderId) return NextResponse.json({ error: "缺少参数" }, { status: 400 });
  const data = await listMessages({
    userId: user.id,
    accountId,
    folderId,
    cursor: sp.get("cursor"),
    q: sp.get("q"),
    unreadOnly: sp.get("unread") === "1",
    flaggedOnly: sp.get("flagged") === "1",
    category: sp.get("category"),
  });
  return NextResponse.json(data);
}
