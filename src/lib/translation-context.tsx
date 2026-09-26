"use client";

import { createContext, useContext } from "react";
import type { TranslationLang } from "@/db/schema";

/** 翻译相关配置（来自用户的 AI 设置），供阅读界面用。 */
interface TranslationConfig {
  langs: TranslationLang[];
  /** 阅读时自动把非中/英文邮件译成英文 */
  autoEnglish: boolean;
}

const TranslationContext = createContext<TranslationConfig>({ langs: [], autoEnglish: false });

export function TranslationLangsProvider({ langs, autoEnglish, children }: { langs: TranslationLang[]; autoEnglish: boolean; children: React.ReactNode }) {
  return <TranslationContext.Provider value={{ langs, autoEnglish }}>{children}</TranslationContext.Provider>;
}

export function useTranslationLangs(): TranslationLang[] {
  return useContext(TranslationContext).langs;
}

export function useAutoTranslateEnglish(): boolean {
  return useContext(TranslationContext).autoEnglish;
}
