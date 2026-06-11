import { createContext, useContext, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { SaveTickMutationResponse, SaveTickMutationVariables } from '@boardsesh/graphql/operations';

// HTTP transport for tick + logbook operations. Query is a `string` since
// the `gql` template tag in `graphql-request` returns the source string at
// runtime — both platforms use that. TVars is constrained to `object` to
// match graphql-request's signature.
export type ExecuteHttp = <TData, TVars extends object = Record<string, unknown>>(
  query: string,
  variables?: TVars,
) => Promise<TData>;

// WebSocket transport for create/update climb operations. Matches the
// `@boardsesh/graphql-client` `execute(client, { query, variables })`
// shape; the platform creates+disposes (web) or uses a singleton (mobile).
export type ExecuteWs = <TData, TVars extends Record<string, unknown> = Record<string, unknown>>(operation: {
  query: string;
  variables?: TVars;
}) => Promise<TData>;

export type BoardAdapter = {
  /** Whether the user is signed in. */
  isAuthenticated: boolean;
  /** True while auth state is still resolving (pre-session-status === 'loading'). */
  isAuthLoading: boolean;
  executeHttp: ExecuteHttp;
  executeWs: ExecuteWs;
  /**
   * Returns the platform-specific active-session id used as the default
   * when a SaveTickOptions call omits `sessionId`. Web reads from
   * persistent-session context; mobile reads from the queue provider.
   * Read at call-time (not memoised) so a freshly created session is
   * captured for the next mutation without re-renders.
   */
  resolveActiveSessionId: () => string | null | undefined;
  /**
   * Optional platform-local save path. Mobile uses this to commit a tick to
   * SQLite and enqueue the GraphQL replay before falling back to network-only
   * behavior when no local database is available. Web omits it.
   */
  saveTickOffline?: (
    variables: SaveTickMutationVariables,
    helpers: { queryClient: QueryClient; executeHttp: ExecuteHttp },
  ) => Promise<SaveTickMutationResponse['saveTick'] | null>;
  /**
   * Optional post-save side-effect. Web wires `clearTickDraft` (IndexedDB);
   * mobile has no tick-draft store today and may omit it.
   */
  onTickSaved?: (climbUuid: string, angle: number) => void;
  /**
   * Optional fallback error UI for save-climb/update-climb. Web uses a
   * snackbar; mobile uses a toast. Shared code emits a stable reason
   * identifier — the adapter translates to a user-facing message and
   * displays it in the platform's UI helper.
   */
  showError?: (reason: BoardErrorReason) => void;
};

/** Stable identifiers for fallback-toast errors the shared hooks can raise. */
export type BoardErrorReason = 'saveClimbFailed' | 'updateClimbFailed';

const BoardAdapterContext = createContext<BoardAdapter | undefined>(undefined);

export function BoardAdapterProvider({ value, children }: { value: BoardAdapter; children: ReactNode }) {
  return <BoardAdapterContext.Provider value={value}>{children}</BoardAdapterContext.Provider>;
}

export function useBoardAdapter(): BoardAdapter {
  const adapter = useContext(BoardAdapterContext);
  if (adapter === undefined) {
    throw new Error(
      'useBoardAdapter must be used within a BoardAdapterProvider. Mount the provider near the root of your app with platform-specific auth/client/session wiring.',
    );
  }
  return adapter;
}
