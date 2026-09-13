import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { getMessageDetail } from "@/server/mail/queries";

export const dynamic = "force-dynamic";

/** GET /api/mail/messages/:id?remote=1 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/mail/messages/[id]">) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { id } = await ctx.params;
  const detail = await getMessageDetail(user.id, id, { allowRemoteImages: req.nextUrl.searchParams.get("remote") === "1" });
  if (!detail) return NextResponse.json({ error: "邮件不存在" }, { status: 404 });
  return NextResponse.json(detail);
}
