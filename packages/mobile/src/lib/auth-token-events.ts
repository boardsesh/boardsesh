import type { AuthTokenChangeListener } from './auth-token-change-types';

export type { AuthTokenChangeListener, AuthTokenChangeSource } from './auth-token-change-types';

/** Native auth state is process-local and has no browser tabs to coordinate. */
export function subscribeAuthTokenChanges(_listener: AuthTokenChangeListener): () => void {
  return () => {};
}
