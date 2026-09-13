import { NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { getSidebarData } from "@/server/mail/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json(await getSidebarData(user.id));
}
