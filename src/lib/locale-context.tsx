"use client";

import { createContext, useContext } from "react";
import { DEFAULT_LOCALE, getDict, type Dict, type Locale } from "./i18n";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useT(): Dict {
  return getDict(useContext(LocaleContext));
}
