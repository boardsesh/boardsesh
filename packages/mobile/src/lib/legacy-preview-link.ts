import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@boardsesh/i18n';

const LEGACY_PREVIEW_PREFIX = /^(?:https:\/\/(?:www\.)?boardsesh\.com(?:\/|$)|com\.boardsesh\.app:\/\/\/?)/i;
const LEGACY_PREVIEW_BRANCH = /^pr-([1-9]\d*)$/;
const LOCALE_PREFIXES: ReadonlySet<string> = new Set(SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE));

/** Recognize durable links emitted by Boardsesh's retired OTA picker. */
export function isLegacyPreviewLink(url: string): boolean {
  const normalizedPath = url.replace(LEGACY_PREVIEW_PREFIX, '/').split(/[?#]/, 1)[0];
  if (!normalizedPath.startsWith('/')) return false;

  const segments = normalizedPath.split('/').filter((segment) => segment.length > 0);
  if (segments.length > 0 && LOCALE_PREFIXES.has(segments[0])) segments.shift();
  if (segments.length !== 2 || segments[0] !== 'preview') return false;

  const branchMatch = LEGACY_PREVIEW_BRANCH.exec(segments[1]);
  return branchMatch !== null && Number.isSafeInteger(Number(branchMatch[1]));
}
