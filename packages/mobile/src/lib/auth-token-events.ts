export type AuthTokenChangeSource = 'local' | 'remote' | 'session' | 'hint';
export type AuthTokenChangeListener = (token: string | null, source: AuthTokenChangeSource) => void;

/** Native auth state is process-local and has no browser tabs to coordinate. */
export function subscribeAuthTokenChanges(_listener: AuthTokenChangeListener): () => void {
  return () => {};
}
