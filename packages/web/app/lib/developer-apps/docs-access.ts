import { parsePartnerOAuthMode } from '@boardsesh/auth-protocol/partner-oauth-mode';

/**
 * What the public developer docs at `/developers` can truthfully say, read from
 * this web service's own `PARTNER_OAUTH_MODE` (the backend reads its own copy,
 * and a mode change is set on both).
 *
 * - `unavailable`: `off` and `hold`. Apps cannot connect (`hold` answers 503 on
 *   every partner route), so the page is a 404 rather than a promise.
 * - `invitation`: `allowlist`. Apps work, but only developer accounts the
 *   Boardsesh team added can register one. The page is served and noindex.
 * - `open`: `open`. The only state the page is indexable and in the sitemap.
 *   Registration requires the independent developer email proof; the historical
 *   users.emailVerified stamp alone never opens developer access.
 */
export type DeveloperDocsState = 'unavailable' | 'invitation' | 'open';

export function getDeveloperDocsState(
  rawMode: string | undefined = process.env.PARTNER_OAUTH_MODE,
): DeveloperDocsState {
  const mode = parsePartnerOAuthMode(rawMode);
  if (mode === 'allowlist') return 'invitation';
  if (mode === 'open') return 'open';
  return 'unavailable';
}

/** True only in the one state where outsiders can act: indexable and in the sitemap. */
export function developerDocsIndexable(rawMode: string | undefined = process.env.PARTNER_OAUTH_MODE): boolean {
  return getDeveloperDocsState(rawMode) === 'open';
}
