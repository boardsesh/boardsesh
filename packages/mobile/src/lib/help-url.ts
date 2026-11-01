import { DEFAULT_LOCALE, isWebLocale } from '@boardsesh/i18n';
import { WEB_BASE_URL } from './env';

/** The www /help topic pages the app links to. */
export type HelpTopic = 'spray-walls';

/**
 * A www help page in the language the app is running in.
 *
 * www carries locale as a path prefix (`/es/help/...`) with en-US unprefixed, so
 * the climber lands on the page in the language they were just reading. A
 * language www does not serve (an app-only one such as zh-Hans) falls back to
 * the unprefixed English page rather than a 404.
 */
export function buildHelpUrl(topic: HelpTopic, language: string | undefined, baseUrl: string = WEB_BASE_URL): string {
  const prefix = isWebLocale(language) && language !== DEFAULT_LOCALE ? `/${language}` : '';
  return `${baseUrl.replace(/\/+$/, '')}${prefix}/help/${topic}`;
}
