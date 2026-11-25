import { notFound } from 'next/navigation';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, isSupportedLocale, type Locale } from './config';

export const LOCALIZED_HOME_LOCALES = SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);

/** The public locale segment is a build-time input, independent of request headers. */
export function localizedHomeLocale(segment: string): Locale {
  if (!isSupportedLocale(segment) || segment === DEFAULT_LOCALE) notFound();
  return segment;
}
