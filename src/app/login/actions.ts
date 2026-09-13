"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/auth";

export type LoginState = { error?: string } | undefined;

/** 登录 Server Action：成功时由 Auth.js 触发跳转到 /mail。 */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "请输入邮箱和密码" };

  try {
    await signIn("credentials", { email, password, redirectTo: "/mail" });
    return undefined;
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: "邮箱或密码错误" };
    }
    // Next.js 的 redirect() 通过抛异常实现，必须原样抛出
    throw err;
  }
}
