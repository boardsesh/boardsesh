import { synchronizeWebSession, type AuthSessionResult } from './auth-store.web';

export type { AuthSessionResult } from './auth-store.web';

/** Resolve the HttpOnly NextAuth session and its memory-only backend token. */
export function resolveAuthSession(): Promise<AuthSessionResult> {
  return synchronizeWebSession();
}
