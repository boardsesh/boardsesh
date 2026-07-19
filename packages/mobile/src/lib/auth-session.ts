import { deduplicatedRefresh } from './auth-interceptor';
import {
  captureAuthCredentialGeneration,
  getAuthToken,
  isAuthCredentialGenerationCurrent,
  isTokenExpiringSoon,
} from './auth-store';
import type { UserStorageOwner } from './user-storage-owner';

export type AuthSessionResult =
  | { status: 'authenticated'; token: string; userId?: string; authSessionId?: string }
  | { status: 'anonymous' }
  | { status: 'superseded' }
  | {
      status: 'unavailable';
      error: unknown;
      confirmedIdentity?: UserStorageOwner;
      identityInvalidated?: boolean;
    };

/** Resolve the native mobile JWT session, refreshing it when necessary. */
export async function resolveAuthSession(): Promise<AuthSessionResult> {
  const credentialGeneration = captureAuthCredentialGeneration();
  try {
    const currentToken = await getAuthToken();
    if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return { status: 'superseded' };
    if (!currentToken) return { status: 'anonymous' };

    const tokenExpiringSoon = await isTokenExpiringSoon();
    if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return { status: 'superseded' };
    if (tokenExpiringSoon) {
      // Refresh via the status-returning path (not the boolean `ensureFreshToken`,
      // which collapses rejected and unavailable into the same `false`). A
      // server-rejected refresh token is a real logout; a transient network
      // failure must NOT sign the user out.
      const refreshResult = await deduplicatedRefresh();
      if (!isAuthCredentialGenerationCurrent(credentialGeneration) || refreshResult.status === 'superseded') {
        return { status: 'superseded' };
      }
      if (refreshResult.status === 'rejected') return { status: 'anonymous' };
      if (refreshResult.status === 'unavailable') {
        // Preserve the session and let the caller retry, instead of a false logout.
        return { status: 'unavailable', error: new Error('Token refresh unavailable') };
      }

      const refreshedToken = await getAuthToken();
      if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return { status: 'superseded' };
      if (!refreshedToken) return { status: 'anonymous' };
      return { status: 'authenticated', token: refreshedToken };
    }

    return isAuthCredentialGenerationCurrent(credentialGeneration)
      ? { status: 'authenticated', token: currentToken }
      : { status: 'superseded' };
  } catch (error) {
    return isAuthCredentialGenerationCurrent(credentialGeneration)
      ? { status: 'unavailable', error }
      : { status: 'superseded' };
  }
}
