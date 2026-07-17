import { ensureFreshToken } from './auth-interceptor';
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
      const refreshed = await ensureFreshToken();
      if (!refreshed) {
        return isAuthCredentialGenerationCurrent(credentialGeneration)
          ? { status: 'anonymous' }
          : { status: 'superseded' };
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
