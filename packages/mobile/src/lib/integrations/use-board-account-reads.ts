import { useQuery, type Query, type NetworkMode } from '@tanstack/react-query';
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

async function readForView<T>(
  view: RestReadView,
  signal: AbortSignal | undefined,
  read: (operation: RestOperation) => Promise<RestReadOutcome<T>>,
): Promise<T> {
  const operation = createRestOperation(view.scope, view.scoped ? { signal } : undefined);
  try {
    const outcome = await read(operation);
    outcome.assertCurrent();
    if (!outcome.ok) throw outcome.error;
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
  return useQuery({
    queryKey: view.key(AURORA_CREDENTIALS_QUERY_KEY),
    queryFn: (context) => readForView(view, view.scoped ? context.signal : undefined, getAuroraCredentialsWithReceipt),
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
