import { getPreference, removePreference, setPreference } from './preference-store';
import type { AuthProvider } from './auth';

const OAUTH_PENDING_KEY = 'auth:oauth-pending';
const OAUTH_PENDING_MAX_AGE_MS = 5 * 60 * 1000;

export type OAuthPendingMarker = {
  provider: AuthProvider;
  attemptedAt: number;
  isRegistration: boolean;
};

function isOAuthPendingMarker(candidate: unknown): candidate is OAuthPendingMarker {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
  const marker = candidate as Record<string, unknown>;
  return (
    (marker.provider === 'google' || marker.provider === 'apple') &&
    typeof marker.attemptedAt === 'number' &&
    Number.isFinite(marker.attemptedAt) &&
    typeof marker.isRegistration === 'boolean'
  );
}

export function setOAuthPending(marker: OAuthPendingMarker): Promise<void> {
  return setPreference(OAUTH_PENDING_KEY, marker);
}

/**
 * Consume a browser-OAuth attempt after the returned NextAuth cookie has been
 * confirmed. Storage failures are analytics-only and must never block login.
 */
export async function consumeFreshOAuthPending(): Promise<OAuthPendingMarker | null> {
  let stored: unknown;
  try {
    stored = await getPreference<unknown>(OAUTH_PENDING_KEY);
  } catch {
    return null;
  }
  if (stored === null) return null;

  try {
    await removePreference(OAUTH_PENDING_KEY);
  } catch {
    // A failed cleanup may duplicate telemetry on a later reload, but must not
    // turn a completed OAuth login into an auth failure.
  }

  if (!isOAuthPendingMarker(stored)) return null;
  const age = Date.now() - stored.attemptedAt;
  return age >= 0 && age <= OAUTH_PENDING_MAX_AGE_MS ? stored : null;
}
