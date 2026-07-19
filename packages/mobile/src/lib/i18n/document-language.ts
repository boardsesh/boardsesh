import type { Locale } from '@boardsesh/i18n';

/** Native platforms do not have an HTML document language to synchronize. */
export function syncDocumentLanguage(_language: Locale): void {}
