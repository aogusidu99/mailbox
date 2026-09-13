"use server";

import { cookies } from "next/headers";
import { isLocale, LOCALE_COOKIE } from "@/lib/i18n";

/** 切换界面语言（写 cookie，一年有效） */
export async function setLocaleAction(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, { path: "/", maxAge: 365 * 86_400, sameSite: "lax" });
}
