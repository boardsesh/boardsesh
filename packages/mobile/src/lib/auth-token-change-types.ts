/**
 * Shared types for auth token change notifications. Kept in a module that
 * neither `auth-token-events.ts` nor its `.web` fork re-imports from the
 * other, so `.web`-first resolution (Metro/esbuild) and tsc's native-first
 * resolution both land on the same concrete declaration.
 */
export type AuthTokenChangeSource = 'local' | 'remote' | 'remote-signout' | 'session' | 'hint';
export type AuthTokenChangeListener = (token: string | null, source: AuthTokenChangeSource) => void;
