// WEB FORK — the browser export relaxes the auth gate for read-only board URLs.
//
// A visitor arriving from a www climb front door lands on the same path here.
// Rather than bounce them to a login wall that forgets what they came for, the
// route mounts, decides it needs an account, and hands the path to login as a
// validated `?next=`. Once they sign in, `AuthProvider`'s authenticated branch
// reads that value back and redirects there instead of Home.
//
// Hrefs handed to `<Redirect>` stay base-relative. Expo Router re-applies
// `EXPO_BASE_URL` when it builds the browser URL — which is why every existing
// `<Redirect href="/auth/login">` already works under the `/app` mount — but
// `window.location.pathname` does NOT: it carries the base. So every read of the
// address bar is base-stripped first, and every value written back is not.

import { isReadOnlyAnonymousPath, isSafeReturnPath } from './read-only-routes';

/** The web fork is the one that stands the gate down. */
export const RELAXES_ANONYMOUS_ROUTES = true;

/**
 * The current path as the router sees it — `window.location.pathname` with the
 * export's mount point removed. `EXPO_BASE_URL` is `/app` on the www-mounted
 * export and `/` on the app.boardsesh.com subdomain export, and Expo CLI inlines
 * it at build time. Mirrors `appCallbackUrl()` in `src/lib/auth.web.ts`.
 */
function currentAppPath(): string {
  if (typeof window === 'undefined') return '/';
  const exportBasePath = process.env.EXPO_BASE_URL || '/';
  const normalisedBase = exportBasePath === '/' ? '' : exportBasePath.replace(/\/$/, '');
  const { pathname } = window.location;
  if (!normalisedBase) return pathname;
  if (pathname === normalisedBase) return '/';
  if (pathname.startsWith(`${normalisedBase}/`)) return pathname.slice(normalisedBase.length);
  return pathname;
}

/** Is the browser currently on a board URL a signed-out visitor may render? */
export function isAnonymousReadOnlyLocation(): boolean {
  return isReadOnlyAnonymousPath(currentAppPath());
}

/**
 * The login href a read-only route hands off to, carrying the path so the climb
 * survives the round trip. Anything outside the allow-set gets the bare login
 * route: a `next` the gate itself could not have produced is a `next` we do not
 * want to be asked to honour.
 *
 * The path only — never `window.location.search`. The canonical board URLs carry
 * no meaningful query, and excluding it stops `bs_oauth_*` residue riding along.
 */
export function buildLoginHrefWithReturn(): string {
  const path = currentAppPath();
  if (!isSafeReturnPath(path) || !isReadOnlyAnonymousPath(path)) return '/auth/login';
  return `/auth/login?next=${encodeURIComponent(path)}`;
}

/**
 * The `?next=` in the address bar, if we are willing to follow it.
 *
 * Two independent gates, not one. `isSafeReturnPath` is the open-redirect
 * contract — app-relative, no scheme, no protocol-relative form.
 * `isReadOnlyAnonymousPath` additionally pins the destination to the set the
 * gate itself can produce, so a hand-crafted `?next=` can never reach an
 * arbitrary in-app route. `URLSearchParams.get` decodes once, so `%2f%2fevil`
 * arrives as `//evil` and the protocol-relative rule catches it.
 */
export function readPostLoginReturnHref(): string | null {
  if (typeof window === 'undefined') return null;
  const next = new URLSearchParams(window.location.search).get('next');
  return isSafeReturnPath(next) && isReadOnlyAnonymousPath(next) ? next : null;
}
