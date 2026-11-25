'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_LOCALE, type Locale } from './config';

const DocumentLocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/** The document's server-resolved language, independent of browser translation. */
export function DocumentLocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <DocumentLocaleContext.Provider value={locale}>{children}</DocumentLocaleContext.Provider>;
}

export function useDocumentLocale(): Locale {
  return useContext(DocumentLocaleContext);
}
