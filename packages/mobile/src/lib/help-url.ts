import { DEFAULT_LOCALE, isSupportedLocale } from '@boardsesh/i18n';
import { WEB_BASE_URL } from './env';

/** The www /help topic pages the app links to. */
export type HelpTopic = 'spray-walls' | 'board-and-bluetooth';

/** The sections of a topic page the app links to, by their `PageSection` id. */
export type HelpSection = 'driving';

/**
 * A www help page in the language the app is running in.
 *
 * www carries locale as a path prefix (`/es/help/...`) with en-US unprefixed, so
 * the climber lands on the page in the language they were just reading. A
 * language www does not serve falls back to the unprefixed English page rather
 * than a 404.
 */
export function buildHelpUrl(topic: HelpTopic, language: string | undefined, baseUrl: string = WEB_BASE_URL): string {
  const prefix = isSupportedLocale(language) && language !== DEFAULT_LOCALE ? `/${language}` : '';
  return `${baseUrl.replace(/\/+$/, '')}${prefix}/help/${topic}`;
}

/** A section of a www help page (`/help/board-and-bluetooth#driving`), in the app's language. */
export function buildHelpSectionUrl(
  topic: HelpTopic,
  section: HelpSection,
  language: string | undefined,
  baseUrl: string = WEB_BASE_URL,
): string {
  return `${buildHelpUrl(topic, language, baseUrl)}#${section}`;
}
