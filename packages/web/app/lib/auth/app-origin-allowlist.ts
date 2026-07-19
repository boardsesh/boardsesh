import { APP_PREVIEW_ORIGIN_REGEX } from '@boardsesh/shared-schema/app-origins';
import { APP_URL } from '@/app/lib/app-origin';

// The exact app origin (env-overridable via NEXT_PUBLIC_APP_URL; prod default
// DEFAULT_APP_ORIGIN from @boardsesh/shared-schema/app-origins).
const APP_ORIGIN = (() => {
  try {
    return new URL(APP_URL).origin;
  } catch {
    return null;
  }
})();

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
