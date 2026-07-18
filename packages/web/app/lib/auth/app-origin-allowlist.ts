import { APP_URL } from '@/app/lib/app-origin';

// The exact app origin (env-overridable via NEXT_PUBLIC_APP_URL; prod default
// https://app.boardsesh.com).
const APP_ORIGIN = (() => {
  try {
    return new URL(APP_URL).origin;
  } catch {
    return null;
  }
})();

// …plus numbered homelab previews (https://{N}.app.boardsesh.com), mirroring the
// backend CORS allow-list (packages/backend/src/handlers/cors.ts). Both checks
// are origin-anchored — a `URL.origin` is scheme+host+port with no path, and the
// regex is `^…$`-anchored — so look-alikes like https://app.boardsesh.com.evil.com
// or https://evil-app.boardsesh.com never match.
const APP_PREVIEW_ORIGIN_REGEX = /^https:\/\/\d+\.app\.boardsesh\.com$/;

/**
 * True when `origin` is the standalone Expo-web app's own origin — the exact
 * configured app origin or a numbered app preview. Same-SITE with boardsesh.com.
 *
 * This single anchored allow-list gates every cross-subdomain surface: the
 * credentialed CORS on www's auth endpoints (cross-subdomain-cors.ts) and the
 * NextAuth `redirect` callback that lets a sign-in/sign-out started on the app
 * resolve back to an app-origin URL (auth-options.ts). Keeping one list means a
 * look-alike can never be trusted by one surface but rejected by the other.
 */
export function isAllowedAppOrigin(origin: string | null | undefined): origin is string {
  if (!origin) return false;
  if (APP_ORIGIN !== null && origin === APP_ORIGIN) return true;
  return APP_PREVIEW_ORIGIN_REGEX.test(origin);
}
