"use client";

import { createContext, useContext } from "react";
import type { TranslationLang } from "@/db/schema";

/** 邮件翻译目标语言（来自用户的 AI 设置），供阅读界面的翻译下拉使用。 */
const TranslationLangsContext = createContext<TranslationLang[]>([]);

export function TranslationLangsProvider({ langs, children }: { langs: TranslationLang[]; children: React.ReactNode }) {
  return <TranslationLangsContext.Provider value={langs}>{children}</TranslationLangsContext.Provider>;
}

export function useTranslationLangs(): TranslationLang[] {
  return useContext(TranslationLangsContext);
}
