import { getPreference, removePreference, setPreference } from './preference-store';
import type { AuthProvider } from './auth';
import { WEB_OAUTH_ATTEMPT_ID_PATTERN } from './oauth-return-marker';

const OAUTH_PENDING_KEY_PREFIX = 'auth:oauth-pending:';
const OAUTH_PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export type OAuthPendingMarker = {
  attemptId: string;
  provider: AuthProvider;
  attemptedAt: number;
  isRegistration: boolean;
};

function isOAuthPendingMarker(candidate: unknown): candidate is OAuthPendingMarker {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
  const marker = candidate as Record<string, unknown>;
  return (
    typeof marker.attemptId === 'string' &&
    WEB_OAUTH_ATTEMPT_ID_PATTERN.test(marker.attemptId) &&
    (marker.provider === 'google' || marker.provider === 'apple') &&
    typeof marker.attemptedAt === 'number' &&
    Number.isFinite(marker.attemptedAt) &&
    typeof marker.isRegistration === 'boolean'
  );
}

export function setOAuthPending(marker: OAuthPendingMarker): Promise<void> {
  return setPreference(`${OAUTH_PENDING_KEY_PREFIX}${marker.attemptId}`, marker);
}

/**
 * Consume a browser-OAuth attempt after the returned NextAuth cookie has been
 * confirmed. Storage failures are analytics-only and must never block login.
 */
export async function consumeFreshOAuthPending(attemptId: string): Promise<OAuthPendingMarker | null> {
  if (!WEB_OAUTH_ATTEMPT_ID_PATTERN.test(attemptId)) return null;
  const storageKey = `${OAUTH_PENDING_KEY_PREFIX}${attemptId}`;
  let stored: unknown;
  try {
    stored = await getPreference<unknown>(storageKey);
  } catch {
    return null;
  }
  if (stored === null) return null;

  try {
    await removePreference(storageKey);
  } catch {
    // A failed cleanup may duplicate telemetry on a later reload, but must not
    // turn a completed OAuth login into an auth failure.
  }

  if (!isOAuthPendingMarker(stored) || stored.attemptId !== attemptId) return null;
  const age = Date.now() - stored.attemptedAt;
  return age >= 0 && age <= OAUTH_PENDING_MAX_AGE_MS ? stored : null;
}
