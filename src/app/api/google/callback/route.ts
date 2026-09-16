import { NextResponse, type NextRequest } from "next/server";
import { completeGoogleConnect, GCONN_COOKIE } from "@/server/google/connection";
import { appBaseUrl } from "@/server/oauth/connect";

export const dynamic = "force-dynamic";

/** GET /api/google/callback?code=&state= → 保存日历/任务 token 并回到日历页 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const base = appBaseUrl(req.nextUrl.origin);
  const fail = (message: string) => {
    const res = NextResponse.redirect(new URL(`/mail/calendar?error=${encodeURIComponent(message)}`, base));
    res.cookies.delete(GCONN_COOKIE);
    return res;
  };
  if (sp.get("error")) return fail(`授权被拒绝：${sp.get("error_description") || sp.get("error")}`);
  const code = sp.get("code");
  const state = sp.get("state");
  if (!code || !state) return fail("缺少 code 或 state 参数");
  try {
    const { email } = await completeGoogleConnect({ code, state, cookieValue: req.cookies.get(GCONN_COOKIE)?.value, origin: req.nextUrl.origin });
    const res = NextResponse.redirect(new URL(`/mail/calendar?connected=${encodeURIComponent(email || "google")}`, base));
    res.cookies.delete(GCONN_COOKIE);
    return res;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
