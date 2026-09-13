import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { threadFolder } from "@/server/mail/threading";

export const dynamic = "force-dynamic";

/** GET /api/mail/threads?accountId&folderId&q&unread&flagged&category → 按会话汇总 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId");
  const folderId = sp.get("folderId");
  if (!accountId || !folderId) return NextResponse.json({ error: "缺少参数" }, { status: 400 });
  const data = await threadFolder({
    userId: user.id,
    accountId,
    folderId,
    q: sp.get("q"),
    unreadOnly: sp.get("unread") === "1",
    flaggedOnly: sp.get("flagged") === "1",
    category: sp.get("category"),
  });
  return NextResponse.json(data);
}
