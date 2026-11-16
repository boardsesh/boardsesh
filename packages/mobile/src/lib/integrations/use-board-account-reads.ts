import { useQuery, useQueryClient, type QueryClient, type Query, type NetworkMode } from '@tanstack/react-query';
import {
  createRestOperation,
  useRestView,
  type RestOperation,
  type RestReadOutcome,
  type RestReadView,
} from '../rest-operation';
import {
  getAuroraCredentialsWithReceipt,
  getAuroraUnsyncedCountsWithReceipt,
  type AuroraCredentialsResponse,
} from '../aurora-credentials';
import { AURORA_CREDENTIALS_QUERY_KEY, AURORA_UNSYNCED_QUERY_KEY } from './board-account-query-keys';
import type { BoardImportState } from './board-import-completion';
import { reportHandledError } from '../error-reporting';

// The prompt and Connected apps share one cached response and invalidation key.
/** While a board sync is waiting, re-read the credentials this often so "Syncing" clears on its own. */
export const PENDING_SYNC_REFRESH_MS = 20_000;

export function hasPendingSyncRun(response: AuroraCredentialsResponse | undefined): boolean {
  return Boolean(response?.credentials.some((credential) => credential.pendingRunId));
}

/** `refetchInterval` for the credentials query: poll only while some account has a queued sync. */
export function pendingSyncRefetchInterval(query: Pick<Query<AuroraCredentialsResponse>, 'state'>): number | false {
  return hasPendingSyncRun(query.state.data) ? PENDING_SYNC_REFRESH_MS : false;
}

export type AcceptedBoardAccountRead = Readonly<{
  scope: string;
  snapshot: readonly Readonly<BoardImportState>[];
  key(logical: readonly unknown[]): readonly unknown[];
  assertCurrent(): void;
}>;
type AcceptedReadListener = (observation: AcceptedBoardAccountRead) => void;
type AcceptedReadRegistration = Readonly<{ listener: AcceptedReadListener }>;
const acceptedReaders = new WeakMap<QueryClient, Set<AcceptedReadRegistration>>();

/** Subscribe only. Actual credentials query execution owns the sole publisher. */
export function subscribeToAcceptedBoardAccountReads(
  queryClient: QueryClient,
  listener: AcceptedReadListener,
): () => void {
  let listeners = acceptedReaders.get(queryClient);
  if (!listeners) {
    listeners = new Set();
    acceptedReaders.set(queryClient, listeners);
  }
  const ownedListeners = listeners;
  const registration: AcceptedReadRegistration = Object.freeze({ listener });
  ownedListeners.add(registration);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    ownedListeners.delete(registration);
    if (!ownedListeners.size && acceptedReaders.get(queryClient) === ownedListeners)
      acceptedReaders.delete(queryClient);
  };
}

function immutableImportState(response: AuroraCredentialsResponse): readonly Readonly<BoardImportState>[] | null {
  if (!response || !Array.isArray(response.credentials)) return null;
  const entries: Readonly<BoardImportState>[] = [];
  for (const credential of response.credentials) {
    if (
      !credential ||
      typeof credential.boardType !== 'string' ||
      (credential.pendingRunId !== undefined &&
        credential.pendingRunId !== null &&
        typeof credential.pendingRunId !== 'string') ||
      (credential.lastSyncAt !== null && typeof credential.lastSyncAt !== 'string')
    )
      return null;
    entries.push(
      Object.freeze({
        boardType: credential.boardType,
        pendingRunId: credential.pendingRunId ?? null,
        lastSyncAt: credential.lastSyncAt,
      }),
    );
  }
  return Object.freeze(entries);
}

function publishAcceptedCredentials(
  queryClient: QueryClient,
  view: RestReadView,
  response: AuroraCredentialsResponse,
  assertCurrent: () => void,
): void {
  // Native/qualified legacy have only the original raw QueryCache watcher.
  if (view.mode !== 'selected' || !view.scoped || typeof view.scope !== 'string') return;
  assertCurrent();
  const snapshot = immutableImportState(response);
  assertCurrent();
  if (!snapshot) return;
  const prefix = Object.freeze([...view.key([])]);
  const observation: AcceptedBoardAccountRead = Object.freeze({
    scope: view.scope,
    snapshot,
    key: (logical: readonly unknown[]) => Object.freeze([...prefix, ...logical]),
    assertCurrent,
  });
  const listeners = acceptedReaders.get(queryClient);
  for (const registration of Array.from(listeners ?? [])) {
    assertCurrent();
    if (!listeners?.has(registration)) continue;
    const listener = registration.listener;
    try {
      listener(observation);
    } catch {
      // A stale/private consumer error cannot reach a later-owner reporter.
      assertCurrent();
      try {
        reportHandledError(new Error('Board import notification consumer failed'));
      } catch {
        /* Reporter failures cannot replace a valid physical delivery. */
      }
      assertCurrent();
    }
    assertCurrent();
  }
  assertCurrent();
}

async function readForView<T>(
  view: RestReadView,
  signal: AbortSignal | undefined,
  read: (operation: RestOperation) => Promise<RestReadOutcome<T>>,
  accepted?: (result: T, assertCurrent: () => void) => void,
): Promise<T> {
  const operation = createRestOperation(view.scope, view.scoped ? { signal } : undefined);
  try {
    const outcome = await read(operation);
    outcome.assertCurrent();
    if (!outcome.ok) throw outcome.error;
    accepted?.(outcome.result, outcome.assertCurrent);
    outcome.assertCurrent();
    return outcome.result;
  } catch (error) {
    // No-response failures have a veto only; never manufacture a delivery.
    operation.assertAttemptCurrent();
    throw error;
  } finally {
    // Final guard above runs while the original operation still owns authority.
    operation.dispose();
  }
}

type CredentialsReadOptions<Selected> = {
  enabled?: boolean;
  networkMode?: NetworkMode;
  select?: (response: AuroraCredentialsResponse) => Selected;
};

export function useAuroraCredentialsRead<Selected = AuroraCredentialsResponse>(
  options: CredentialsReadOptions<Selected> = {},
  capturedView?: RestReadView,
) {
  const currentView = useRestView();
  const view = capturedView ?? currentView;
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: view.key(AURORA_CREDENTIALS_QUERY_KEY),
    queryFn: (context) =>
      readForView(
        view,
        view.scoped ? context.signal : undefined,
        getAuroraCredentialsWithReceipt,
        (result, assertCurrent) => publishAcceptedCredentials(queryClient, view, result, assertCurrent),
      ),
    ...(options.networkMode === undefined ? {} : { networkMode: options.networkMode }),
    enabled: (options.enabled ?? true) && view.ready && view.isCurrent(),
    select: options.select,
    refetchInterval: view.scoped
      ? (query) => (view.isCurrent() ? pendingSyncRefetchInterval(query) : false)
      : pendingSyncRefetchInterval,
  });
}

export function useAuroraUnsyncedRead(enabled: boolean) {
  const view = useRestView();
  return useQuery({
    queryKey: view.key(AURORA_UNSYNCED_QUERY_KEY),
    queryFn: (context) =>
      readForView(view, view.scoped ? context.signal : undefined, getAuroraUnsyncedCountsWithReceipt),
    enabled: enabled && view.ready && view.isCurrent(),
  });
}
