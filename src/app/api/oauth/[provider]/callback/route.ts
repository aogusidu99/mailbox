import { NextResponse, type NextRequest } from "next/server";
import { appBaseUrl, completeOAuth, OAUTH_COOKIE } from "@/server/oauth/connect";
import { OAUTH_PROVIDERS, type OAuthProviderId } from "@/server/oauth/providers";

export const dynamic = "force-dynamic";

/** GET /api/oauth/google/callback?code=&state= → 建账号并回到邮箱页 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/oauth/[provider]/callback">) {
  const { provider } = await ctx.params;
  if (!(provider in OAUTH_PROVIDERS)) return NextResponse.json({ error: "未知的 OAuth 厂商" }, { status: 404 });
  const sp = req.nextUrl.searchParams;
  // 反代/隧道下 req.nextUrl.origin 可能是容器内网地址（0.0.0.0:3000），跳转一律以 APP_BASE_URL 为准
  const base = appBaseUrl(req.nextUrl.origin);
  const fail = (message: string) => {
    const res = NextResponse.redirect(new URL(`/mail/settings/oauth?error=${encodeURIComponent(message)}`, base));
    res.cookies.delete(OAUTH_COOKIE);
    return res;
  };
  if (sp.get("error")) return fail(`授权被拒绝：${sp.get("error_description") || sp.get("error")}`);
  const code = sp.get("code");
  const state = sp.get("state");
  if (!code || !state) return fail("缺少 code 或 state 参数");
  try {
    const result = await completeOAuth({
      provider: provider as OAuthProviderId,
      code,
      state,
      cookieValue: req.cookies.get(OAUTH_COOKIE)?.value,
      origin: req.nextUrl.origin,
    });
    const res = NextResponse.redirect(new URL(`/mail?connected=${encodeURIComponent(result.email)}`, base));
    res.cookies.delete(OAUTH_COOKIE);
    return res;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
