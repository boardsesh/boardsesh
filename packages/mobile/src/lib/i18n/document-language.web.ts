import type { Locale } from '@boardsesh/i18n';

/** Keep browser assistive technology aligned with the active app locale. */
export function syncDocumentLanguage(language: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
}
