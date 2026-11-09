// The iOS universal-link association file, as data.
//
// The app claims every www path so a shared climb, board or session link opens
// in the app. That claim is only safe for paths the app has a screen for: iOS
// hands a claimed URL to the app without loading the page, the Expo router
// matches nothing, and `+not-found` drops the climber on Home with no error.
//
// Gym pages are the case that matters. The app has `/gyms` (the directory) but
// no `/gym/{slug}` screen, so before this exclusion an iPhone with Boardsesh
// installed that scanned a gym poster opened the app on Home. The www page
// never loaded, so `Gym QR Scanned` never fired and the scan was not counted.
// The same happened to `/gym/{slug}/poster` and `/gym/{slug}/manage`, which are
// web-only by design (see packages/mobile/src/lib/gym-manage-url.ts).
//
// Lives outside the route file because a Next route module may only export its
// HTTP handlers, and the path list needs a test of its own.

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/app/lib/i18n/config';

export const APPLE_APP_ID = '9L3HKPZBH3.com.boardsesh.app';

/**
 * Path prefixes that are web-only: the app has no screen for them, so iOS must
 * leave them in the browser. Each is excluded at the root and under every
 * locale prefix. Written without a trailing slash or wildcard; the builder
 * adds `/*`.
 *
 * `/gym` here does NOT cover `/gyms`: the pattern is `/gym/*`, and the slash is
 * literal. The gym directory keeps opening in the app, which has that screen.
 *
 * `/poster` is the printable board QR page (`/poster/b/{slug}`). The code it
 * prints points at `/b/{slug}`, which still opens the app; the print page
 * itself must load in the browser, including when a phone opens it from the
 * app's in-app browser or from a shared link.
 *
 * `/oauth` is where a partner app sends a climber to sign in and approve access,
 * and `/developers` is the developer console. Neither has an app screen. A
 * claimed consent link would land on Home and the partner's sign-in would never
 * finish. Phones pick up this file days after it changes (see the route), so
 * these entries have to be live at least a week before those pages ship.
 */
export const WEB_ONLY_PATH_PREFIXES = ['/gym', '/poster', '/oauth', '/developers'] as const;

/**
 * Exact paths that are web-only, excluded at the root and under every locale
 * prefix. `NOT /developers/*` needs the literal slash, so it does not match the
 * `/developers` overview page itself.
 *
 * `/auth/error` is where NextAuth sends a failed social sign-in (`pages.error`).
 * The app has no such screen, so a partner's sign-in would land on Home. It is
 * this page only: `/auth/login` stays claimed, because the verify-email redirect
 * goes there and has to keep opening the app.
 */
export const WEB_ONLY_EXACT_PATHS = ['/developers', '/auth/error'] as const;

/** Non-page paths the OS or a build tool fetches. Never locale-prefixed. */
const INFRASTRUCTURE_EXCLUSIONS = ['NOT /api/*', 'NOT /_next/*', 'NOT /monitoring', 'NOT /.well-known/*'] as const;

/**
 * The locale segments www serves pages under (`/es/...`, `/fr/...`). The default
 * locale lives at the root and has no segment.
 */
function localePathSegments(): string[] {
  return SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);
}

/** One `NOT` entry for the pattern at the root, then one under each locale. */
function exclusionsForEveryLocale(pathPattern: string): string[] {
  return [`NOT ${pathPattern}`, ...localePathSegments().map((localeSegment) => `NOT /${localeSegment}${pathPattern}`)];
}

/**
 * The `paths` array for the association file.
 *
 * Order is the contract: iOS walks the list top to bottom and stops at the
 * first pattern that matches, so every `NOT` entry has to sit above the
 * catch-all `/*`. A `NOT` placed after it is never reached.
 *
 * The locale variants are spelled out because `*` only ever extends a pattern
 * to the right. `NOT /gym/*` anchors at the start of the path and does not
 * match `/es/gym/{slug}`, which the app cannot open either: `+not-found`
 * strips the locale, finds no `/gym/{slug}` screen, and falls back to Home.
 */
export function buildAppleAppSiteAssociationPaths(): string[] {
  const webOnlyExclusions = [
    ...WEB_ONLY_PATH_PREFIXES.flatMap((pathPrefix) => exclusionsForEveryLocale(`${pathPrefix}/*`)),
    ...WEB_ONLY_EXACT_PATHS.flatMap((exactPath) => exclusionsForEveryLocale(exactPath)),
  ];
  return [...INFRASTRUCTURE_EXCLUSIONS, ...webOnlyExclusions, '/*'];
}

export function buildAppleAppSiteAssociation() {
  return {
    applinks: {
      apps: [],
      details: [
        {
          appID: APPLE_APP_ID,
          paths: buildAppleAppSiteAssociationPaths(),
        },
      ],
    },
  };
}
