import { redirect } from "next/navigation";
import { auth } from "@/auth";

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
}

/** 获取当前登录用户；未登录返回 null。 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const user = session?.user;
  if (!user?.id || !user.email) return null;
  return { id: user.id, email: user.email, name: user.name };
}

/** 获取当前登录用户；未登录抛错（Server Action / Route Handler 用）。 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error("未登录");
  return user;
}

/** 页面用：未登录直接跳转到 /login（页面与布局并行渲染，页面里不能只依赖布局的跳转）。 */
export async function requireUserPage(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}
