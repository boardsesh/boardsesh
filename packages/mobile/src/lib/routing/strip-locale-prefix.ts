// Undo the web app's locale prefix on a URL the Expo router couldn't match.
//
// Web keeps the locale in the path (`/es/kilter/original/…`, `/fr/b/{slug}/…`)
// and the app's associated-domains entry claims `/*`, so a Spanish climber's
// shared link opens the app — but the Expo route tree has no `[locale]` segment,
// so nothing matches and they land on Home with no climb and no error, while the
// identical English link works. The shared parsers do know how to drop a locale
// segment, but route matching happens first, so that code is never reached.
//
// Stripping here, in the not-found route, is deliberately the LAST resort: it
// only ever sees paths that already failed to match, so it can't shadow a real
// route. Pure and React-free so the segment rules are unit-testable on their own.

import { SUPPORTED_LOCALES } from '@boardsesh/i18n';

const localeSegments: ReadonlySet<string> = new Set<string>(SUPPORTED_LOCALES);

/**
 * `path` with one leading supported-locale segment removed, or `null` when there
 * is nothing to strip — a caller uses `null` to mean "this really is a
 * not-found, handle it the usual way".
 *
 * The locale must be a WHOLE segment: `/estonia/…` and `/es-419/…` keep their
 * first segment, because chopping a prefix off a word would invent a route the
 * user never asked for. A bare `/es` strips to nothing routable, so it reports
 * `null` rather than handing back `/`.
 */
export function stripLocalePrefix(path: string | null | undefined): string | null {
  if (!path) return null;
  const segments = path.split('/');
  // A leading slash leaves an empty first element; tolerate a path without one.
  const localeIndex = segments[0] === '' ? 1 : 0;
  const firstSegment = segments[localeIndex];
  if (firstSegment === undefined || !localeSegments.has(firstSegment)) return null;
  // `/es` and `/es/` carry no destination of their own.
  const rest = segments.slice(localeIndex + 1).join('/');
  if (rest === '') return null;
  return `/${rest}`;
}
