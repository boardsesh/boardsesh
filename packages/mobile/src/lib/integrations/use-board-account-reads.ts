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
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';

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
  assertBrowserGetDispatch?: () => void,
): Promise<T> {
  const operation = createRestOperation(
    view.scope,
    view.scoped
      ? { signal, ...(assertBrowserGetDispatch ? { assertBrowserGetDispatch } : {}) }
      : assertBrowserGetDispatch
        ? { assertBrowserGetDispatch }
        : undefined,
  );
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

/** An immutable original reader entry. These descriptors only restrict new
 * sends; each actual GET still owns its independent physical response proof. */
export type OriginalCredentialsRead = Readonly<{
  view: RestReadView;
  assertView(): void;
  refreshAfterSync(assertOriginal: () => void): Promise<void>;
  retry(assertOriginal: () => void): Promise<void>;
}>;

export function useAuroraCredentialsRead<Selected = AuroraCredentialsResponse>(
  options: CredentialsReadOptions<Selected> = {},
  capturedView?: RestReadView,
) {
  const currentView = useRestView();
  const view = capturedView ?? currentView;
  const queryClient = useQueryClient();
  const queryKey = Object.freeze([...view.key(AURORA_CREDENTIALS_QUERY_KEY)]);
  const execute = (signal: AbortSignal | undefined, assertDispatch?: () => void) =>
    readForView(
      view,
      signal,
      getAuroraCredentialsWithReceipt,
      (response, assertCurrent) => publishAcceptedCredentials(queryClient, view, response, assertCurrent),
      assertDispatch,
    );
  const queryOptions = {
    queryKey,
    queryFn: (context: { signal: AbortSignal }) => execute(view.scoped ? context.signal : undefined),
    ...(options.networkMode === undefined ? {} : { networkMode: options.networkMode }),
    enabled: (options.enabled ?? true) && view.ready && view.isCurrent(),
    select: options.select,
    refetchInterval: view.scoped
      ? (query: Query<AuroraCredentialsResponse>) => (view.isCurrent() ? pendingSyncRefetchInterval(query) : false)
      : pendingSyncRefetchInterval,
  };
  const result = useQuery(queryOptions);
  const assertView = () => {
    if (!view.ready || !view.isCurrent()) throw new BrowserBackendConsumerError('superseded');
  };
  const forceOriginal = async (assertOriginal: () => void) => {
    const assertDispatch = () => {
      assertView();
      assertOriginal();
      assertView();
    };
    assertDispatch();
    if (view.mode === 'native') {
      await result.refetch();
      return;
    }
    let executed = false;
    const ordinaryOptions = queryClient.defaultQueryOptions({
      queryKey,
      queryFn: queryOptions.queryFn,
      ...(options.networkMode === undefined ? {} : { networkMode: options.networkMode }),
    });
    // Building an existing Query does not replace its options. In particular,
    // joining an independent paused/retrying read must not graft our SDK cause.
    const query = queryClient.getQueryCache().build(queryClient, ordinaryOptions);
    const invocationOptions = queryClient.defaultQueryOptions({
      ...ordinaryOptions,
      behavior: {
        onFetch(context) {
          // Capture the actual execute, not the default context.fetchFn, which
          // consults mutable Query.options.queryFn when a paused run resumes.
          context.fetchFn = () => {
            executed = true;
            assertDispatch();
            return execute(view.scoped ? context.signal : undefined, assertDispatch);
          };
        },
      },
    });
    const fetchOriginal = () => {
      try {
        // The public fetch joins pending work BEFORE applying supplied options.
        // Its captured execution keeps E1 even after future options are cleared.
        return query.fetch(invocationOptions, { cancelRefetch: false });
      } finally {
        // Remove only our behavior, never a newer observer's ordinary options.
        // No E1 callback lives in queryFn or any other shared option slot.
        if (query.options.behavior === invocationOptions.behavior)
          query.setOptions({ ...query.options, behavior: undefined });
      }
    };
    try {
      await fetchOriginal();
    } catch (error) {
      if (executed) throw error;
    }
    assertDispatch();
    // Joining an older in-flight snapshot is not a post-queue fresh read.
    // Never cancel it; after settlement make at most one original fresh run.
    if (!executed) {
      await fetchOriginal();
      assertDispatch();
      if (!executed) throw new BrowserBackendConsumerError('unavailable');
    }
  };
  const originalCredentialsRead: OriginalCredentialsRead = Object.freeze({
    view,
    assertView,
    async refreshAfterSync(assertOriginal) {
      assertView();
      assertOriginal();
      const invalidation = queryClient.invalidateQueries({
        queryKey,
        exact: true,
        refetchType: 'none',
      });
      // Observe a reentrant rejection before checking the original caller again.
      const observed = invalidation.then(
        () => ({ ok: true as const }),
        () => ({ ok: false as const }),
      );
      try {
        assertView();
        assertOriginal();
        const settled = await observed;
        assertView();
        assertOriginal();
        if (!settled.ok) throw new BrowserBackendConsumerError('unavailable');
        await forceOriginal(assertOriginal);
      } finally {
        await observed;
      }
    },
    retry: forceOriginal,
  });
  return { ...result, originalCredentialsRead };
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
