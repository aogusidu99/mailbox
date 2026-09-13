import { cookies } from "next/headers";
import { DEFAULT_LOCALE, getDict, isLocale, LOCALE_COOKIE, type Dict, type Locale } from "./i18n";

/** 服务端读取当前语言（cookie） */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export async function getServerDict(): Promise<Dict> {
  return getDict(await getLocale());
}
