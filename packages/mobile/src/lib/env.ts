export const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? 'https://ws.boardsesh.com';
export const WEB_BASE_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://www.boardsesh.com';

/**
 * Which origin a shared climb link points at — `EXPO_PUBLIC_APP_URL` (the
 * standalone Expo-web export, i.e. this app in a browser) when set, otherwise
 * the Next.js app.
 *
 * Deliberately still WEB_BASE_URL by default. A shared link is permanent once
 * it lands in someone's chat thread, and app.boardsesh.com only resolves for
 * everyone once it serves both the export and its own
 * /.well-known/apple-app-site-association (Universal Links are per-host, and
 * that host is not claimed yet — see NEXT_APP_LINK_HOSTS in app.config.ts). So
 * with the var unset we emit exactly what we emit today, and setting it in the
 * build env moves every share link to the app subdomain in one flip.
 */
export function resolveClimbShareBaseUrl(appUrlOverride: string, webBaseUrl: string): string {
  return appUrlOverride.length > 0 ? appUrlOverride : webBaseUrl;
}

export const CLIMB_SHARE_BASE_URL = resolveClimbShareBaseUrl(
  process.env.EXPO_PUBLIC_APP_URL?.trim() ?? '',
  WEB_BASE_URL,
);

/**
 * Resolve a Next.js web API path (e.g. `/api/auth/session`) to the URL the
 * Expo-web app should fetch.
 *
 * On the standalone app (app.boardsesh.com) the Next auth + ws-auth endpoints
 * live on a *different* origin (www.boardsesh.com = `WEB_BASE_URL`), so those
 * fetches must target the absolute web origin and be sent with
 * `credentials: 'include'` for the shared `.boardsesh.com` session cookie to
 * ride along. When the app is served same-origin as the web app (the `/app` dev
 * proxy, where `WEB_BASE_URL` resolves to the current page's origin) a relative
 * path is returned so nothing has to be cross-origin in dev. When there's no
 * `window` (SSR/tests) we can't compare origins, so default to absolute — which,
 * paired with `credentials: 'include'`, works in every case.
 */
export function webApiUrl(path: string): string {
  if (typeof window !== 'undefined') {
    try {
      if (new URL(WEB_BASE_URL).origin === window.location.origin) return path;
    } catch {
      // Unparseable WEB_BASE_URL — fall through to the absolute form below.
    }
  }
  return `${WEB_BASE_URL}${path}`;
}

// Base URL for the board-snapshot manifest directory (offline-sync Phase 2/4):
// `${SNAPSHOT_BASE_URL}/manifest.json` is the manifest; each entry's own `url`
// is an absolute artifact URL, so this constant is only used for the manifest
// fetch. Mirrors one of packages/backend/src/scripts/export-board-snapshots.ts's
// key prefixes — the CI workflows point it at the gzip-encoded catalog,
// `board-snapshots/v1-gzip` — served from the same Tigris/S3 bucket
// packages/backend/src/storage/s3.ts uploads to. This must be supplied by the
// EAS build environment; there is deliberately no guessed production fallback.
//
// EXPO_PUBLIC_* vars are inlined at build time, not read at runtime.
export const SNAPSHOT_BASE_URL = (process.env.EXPO_PUBLIC_SNAPSHOT_BASE_URL?.trim() ?? '').replace(/\/+$/, '');

export function isSnapshotBaseUrlConfigured(): boolean {
  return SNAPSHOT_BASE_URL.length > 0;
}
