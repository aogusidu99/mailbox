import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { getAttachmentContent } from "@/server/mail/queries";

export const dynamic = "force-dynamic";

/** GET /api/mail/attachments/:id?inline=1 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/mail/attachments/[id]">) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const result = await getAttachmentContent(user.id, id);
    if (!result) return NextResponse.json({ error: "附件不存在" }, { status: 404 });
    const inline = req.nextUrl.searchParams.get("inline") === "1";
    const disposition = inline ? "inline" : "attachment";
    const encoded = encodeURIComponent(result.filename);
    return new NextResponse(new Uint8Array(result.content), {
      headers: {
        "Content-Type": result.mimeType,
        "Content-Length": String(result.content.length),
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
