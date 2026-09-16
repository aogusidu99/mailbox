import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { GCONN_COOKIE, startGoogleConnect } from "@/server/google/connection";

export const dynamic = "force-dynamic";

/** GET /api/google/start → 跳转到 Google 授权页（日历 + 任务范围） */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.nextUrl));
  try {
    const { url, cookieValue } = await startGoogleConnect(user.id, req.nextUrl.origin);
    const res = NextResponse.redirect(url);
    res.cookies.set(GCONN_COOKIE, cookieValue, { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/api/google", maxAge: 600 });
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.redirect(new URL(`/mail/calendar?error=${encodeURIComponent(message)}`, req.nextUrl));
  }
}
