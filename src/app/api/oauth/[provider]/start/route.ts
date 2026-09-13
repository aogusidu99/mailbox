import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { OAUTH_COOKIE, startOAuth } from "@/server/oauth/connect";
import { OAUTH_PROVIDERS, type OAuthProviderId } from "@/server/oauth/providers";

export const dynamic = "force-dynamic";

/** GET /api/oauth/google/start?login_hint=xxx → 跳转到厂商授权页 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/oauth/[provider]/start">) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.nextUrl));
  const { provider } = await ctx.params;
  if (!(provider in OAUTH_PROVIDERS)) return NextResponse.json({ error: "未知的 OAuth 厂商" }, { status: 404 });
  try {
    const { url, cookieValue } = await startOAuth(user.id, provider as OAuthProviderId, req.nextUrl.origin, req.nextUrl.searchParams.get("login_hint") ?? undefined);
    const res = NextResponse.redirect(url);
    res.cookies.set(OAUTH_COOKIE, cookieValue, { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/api/oauth", maxAge: 600 });
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.redirect(new URL(`/mail/settings/oauth?error=${encodeURIComponent(message)}`, req.nextUrl));
  }
}
