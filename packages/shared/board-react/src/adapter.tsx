import { createContext, useContext, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { SaveTickMutationResponse, SaveTickMutationVariables } from '@boardsesh/graphql/operations';
import type { ClimbStatsForClimbEntry } from '@boardsesh/graphql/operations';
import type { ClimbStatsEvent } from '@boardsesh/shared-schema';

export type ClimbStatsSubscriptionHandlers = {
  next: (event: ClimbStatsEvent) => void;
  connected: () => void;
  error: (error: unknown) => void;
};

// Intentional structural mirror of MutationDeliveryEvent in
// @boardsesh/offline-sync. board-react cannot depend on offline-sync; keep both
// event contracts in sync when fields change.
export type OfflineMutationDelivery = {
  tableName: string;
  operation: string;
  idempotencyKey: string;
  status: 'acknowledged' | 'dead_letter';
};

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
  /** Monotonic platform auth generation used to fence late mutation callbacks. */
  captureAuthEpoch?: () => number;
  isAuthEpochCurrent?: (epoch: number) => boolean;
  /**
   * Explicit platform capability for optimistic community-stat floors. Mobile
   * supplies the immutable climb count on every tick entry point; legacy Next
   * does not, so it must not create tokens accidentally.
   */
  supportsClimbStatsOptimism?: true;
  /** Primary-backed canonical batch read; one response covers every requested climb and angle. */
  fetchClimbStatsForClimbs?: (boardType: string, climbUuids: string[]) => Promise<ClimbStatsForClimbEntry[]>;
  /** Layout-wide stream multiplexed over the platform's singleton graphql-ws client. */
  subscribeClimbStats?: (boardType: string, layoutId: number, handlers: ClimbStatsSubscriptionHandlers) => () => void;
  /**
   * Optional local persistence for a live stats event. Called right after the
   * in-memory store, for every event that matches the subscribed board and
   * layout — regardless of whether any selector retains that climb, since the
   * point is to keep the on-device catalog fresh for the reads that never touch
   * the store (list re-reads, filters, the count, the detail).
   *
   * Must never throw and must never block: the shared hook calls it inside the
   * subscription's `next` handler. Mobile forwards to the SQLite write-through;
   * web has no local database and omits it.
   */
  persistClimbStatsEvent?: (event: ClimbStatsEvent) => void;
  /** Offline outbox acknowledgement/dead-letter notifications keyed by tick UUID. */
  subscribeOfflineMutationDelivery?: (listener: (event: OfflineMutationDelivery) => void) => () => void;
  /** Renderer timer seam; returns cancellation for the scheduled one-shot task. */
  scheduleTask?: (callback: () => void, delayMs: number) => () => void;
  /**
   * Optional platform-local save path. Mobile uses this to commit a tick to
   * SQLite and enqueue the GraphQL replay before falling back to network-only
   * behavior when no local database is available. Web omits it.
   *
   * The adapter MAY stamp `variables.input.uuid` with the id it queued the tick
   * under, and mobile does. `useSaveTick` sends that SAME `variables` object on
   * the fall-through, and the server's `saveTick` dedupes on
   * `SaveTickInput.uuid` — so the local write, the outbox replay and the network
   * fall-through all resolve to one server row. Without the stamp, a write that
   * committed its outbox row and still threw (a `SQLITE_BUSY` surfacing at
   * COMMIT) would deliver the same send twice with no way to merge them.
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
