import { captureConfirmedWebAuthIdentity } from './auth-store.web';
import type { LocalUserIdReader } from './local-user-id';

/**
 * Browser sessions have no readable token id: `getAuthToken()` returns the
 * backend's 5-segment compact JWE, whose claims are encrypted, so the native
 * JWT decode reads it as "no id" and My Boards falls back to one flat list
 * (#4321). The id is already in this tab — `/api/auth/session` confirmed it
 * before the token was ever paired with it — so read it from there.
 *
 * Null until the first session synchronisation confirms an identity, which
 * always happens before AuthProvider flips `isAuthenticated` (the only thing
 * that enables the caller). Fails soft either way: no id means the old flat
 * list, never a wrong id.
 *
 * `import type` above is the compile-time parity guard against the native
 * sibling; it is fully erased, so no native module reaches the web bundle.
 */
export const readLocalUserId: LocalUserIdReader = async () => captureConfirmedWebAuthIdentity()?.userId;
