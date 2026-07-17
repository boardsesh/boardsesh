/**
 * Expo-web rollout: the flag-gated per-surface redirect map that routes
 * logged-in web visitors from migrated board surfaces to the `/app` Expo-web
 * SPA. Everything here is edge-safe (no `server-only`, no `next/headers`) so
 * `middleware.ts` can import it, plus a pair of SSR-guarded `document.cookie`
 * writers used by the client hook that mirrors the PostHog flag into a cookie.
 *
 * Off in every dimension by default: no `BOARDSESH_WEB=1`, no `bs_expo_web`
 * cookie (the flag hasn't resolved true for this visitor), or no auth session
 * cookie all mean "no redirect, classic UI". The `expo-web-app` PostHog flag
 * (id 767179, project 412845) is the master switch; `?classic=1` / the
 * `bs_classic` cookie is the always-available escape hatch back to classic.
 *
 * Why a cookie and not a server-side flag eval: the web app evaluates PostHog
 * flags only on the client (posthog-js-lite, read by FeatureFlagsProvider).
 * Middleware runs on the edge and cannot call PostHog, so the client mirrors
 * the resolved `expo-web-app` value into the non-HttpOnly `bs_expo_web` cookie
 * (see ExpoWebRolloutCookieSync) and the edge reads that. A visitor whose flag
 * hasn't resolved yet simply has no cookie and stays on the classic UI — the
 * safe default.
 */
import type { NextRequest } from 'next/server';
import { getBoardRouteSegments, isBoardRoutePath } from './board-route-paths';

/** PostHog flag key (id 767179, project 412845). Master switch for the rollout. */
export const EXPO_WEB_FLAG = 'expo-web-app';

/** Client-mirrored flag cookie the edge reads. `1` = flag resolved true. */
export const EXPO_WEB_ENABLED_COOKIE = 'bs_expo_web';

/** Escape-hatch cookie: forces classic UI even when the flag is on. */
export const EXPO_WEB_CLASSIC_COOKIE = 'bs_classic';

/** Escape-hatch query param: `?classic=1` pins the `bs_classic` cookie. */
export const EXPO_WEB_CLASSIC_PARAM = 'classic';

/** Mount point of the Expo-web SPA (matches app.config `baseUrl: '/app'`). */
export const EXPO_WEB_APP_BASE = '/app';

const EXPO_WEB_CLIMBS_PATH = `${EXPO_WEB_APP_BASE}/climbs`;

// next-auth writes the secure-prefixed cookie under HTTPS and the bare name
// otherwise (see lib/auth/secure-cookies.ts). Mirror getServerAuthToken and
// accept either — presence is the login heuristic, same as the rest of the app.
const NEXT_AUTH_SESSION_COOKIES = ['__Secure-next-auth.session-token', 'next-auth.session-token'] as const;

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Master env gate. The redirect never fires unless the site is built with the
 * Expo-web surface available (`BOARDSESH_WEB=1`). Note this is intentionally
 * looser than `isExpoWebProxyEnabled()` in middleware: production serves the
 * static export with no `BOARDSESH_EXPO_WEB_ORIGIN`, so the rollout must not
 * also require the dev proxy origin.
 */
export function isExpoWebRolloutEnabled(): boolean {
  return process.env.BOARDSESH_WEB === '1';
}

/** True when the request carries a next-auth session cookie (logged in). */
export function hasAuthSessionCookie(request: NextRequest): boolean {
  return NEXT_AUTH_SESSION_COOKIES.some((name) => Boolean(request.cookies.get(name)?.value));
}

/** True when the visitor's mirrored `expo-web-app` flag cookie is on. */
export function isExpoWebFlagCookieOn(request: NextRequest): boolean {
  return request.cookies.get(EXPO_WEB_ENABLED_COOKIE)?.value === '1';
}

/** True when the visitor opted back into classic via the `bs_classic` cookie. */
export function hasClassicOptOutCookie(request: NextRequest): boolean {
  return request.cookies.get(EXPO_WEB_CLASSIC_COOKIE)?.value === '1';
}

function buildClimbsTarget(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query ? `${EXPO_WEB_CLIMBS_PATH}?${query}` : EXPO_WEB_CLIMBS_PATH;
}

function buildClimbTarget(climbUuid: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  const base = `${EXPO_WEB_CLIMBS_PATH}/${encodeURIComponent(climbUuid)}`;
  return query ? `${base}?${query}` : base;
}

/**
 * Per-surface redirect map. Returns the `/app` SPA path (with a board-context
 * query string) for a migrated board surface, or `null` for everything else —
 * public/SEO routes (profiles, playlists, gyms, setters), board create/queue,
 * API routes, and anything unrecognised all fall through to the classic UI.
 *
 * Migrated surfaces (Expo Router URL shapes; the SPA is client-routed under
 * `/app`, so a plain path redirect resolves to `index.html` and the router
 * takes over):
 *
 *   Board list -> `/app/climbs` (the Climbs tab)
 *     legacy  /[board]/[layout]/[size]/[sets]/[angle]/list
 *     slug    /b/[slug]/[angle]/list
 *   Climb view -> `/app/climbs/[uuid]` (the ClimbDetail deep-link route, which
 *   opens the play drawer — the native app's own deep-link target for a climb)
 *     legacy  /[board]/[layout]/[size]/[sets]/[angle]/view/[uuid]
 *     slug    /b/[slug]/[angle]/view/[uuid]
 *
 * Board context rides the query string. The legacy form carries the exact
 * param contract the mobile ClimbDetail route reads (boardName/layoutId/sizeId/
 * setIds/angle); the slug form carries boardSlug + angle (the SPA resolves the
 * slug). Locale prefixes (`/es/…`, `/fr/…`) are stripped — `/app` is
 * locale-neutral.
 */
export function mapToExpoWebTarget(pathname: string): string | null {
  if (!isBoardRoutePath(pathname)) return null;

  const segments = getBoardRouteSegments(pathname);

  if (segments[0] === 'b') {
    const [, boardSlug, angle, surface, climbUuid] = segments;
    if (!boardSlug || !angle) return null;
    const params = { boardSlug, angle };
    if (surface === 'list' && segments.length === 4) {
      return buildClimbsTarget(params);
    }
    if (surface === 'view' && segments.length === 5 && climbUuid) {
      return buildClimbTarget(climbUuid, params);
    }
    return null;
  }

  const [boardName, layoutId, sizeId, setIds, angle, surface, climbUuid] = segments;
  if (!boardName || !layoutId || !sizeId || !setIds || !angle) return null;
  const params = { boardName, layoutId, sizeId, setIds, angle };
  if (surface === 'list' && segments.length === 6) {
    return buildClimbsTarget(params);
  }
  if (surface === 'view' && segments.length === 7 && climbUuid) {
    return buildClimbTarget(climbUuid, params);
  }
  return null;
}

/**
 * Client-side mirror of the resolved `expo-web-app` flag into the `bs_expo_web`
 * cookie the edge reads. `true` writes `bs_expo_web=1`; `false` clears it so a
 * flag flipped back off (or a user removed from the rollout cohort) instantly
 * stops redirecting. SSR-guarded — a no-op on the server.
 */
export function setExpoWebEnabledCookie(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  if (enabled) {
    document.cookie = `${EXPO_WEB_ENABLED_COOKIE}=1; path=/; SameSite=Lax; max-age=${ONE_YEAR_SECONDS}`;
  } else {
    document.cookie = `${EXPO_WEB_ENABLED_COOKIE}=; path=/; SameSite=Lax; max-age=0`;
  }
}
