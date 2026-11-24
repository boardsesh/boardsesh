import type { GymReportingBoard, GymStats, GymStatsPeriod } from '@boardsesh/shared-schema';
import { hasGraphqlErrorCode } from './errors';

export const GYM_REPORTING_QUERY_ROOT = 'gym-reporting';
export const GYM_REPORTING_PERIODS = [
  { key: 'week', days: 7 },
  { key: 'month', days: 30 },
  { key: 'quarter', days: 90 },
] as const;

export const gymReportingQueryPrefix = (viewer: string, gymUuid: string) =>
  [GYM_REPORTING_QUERY_ROOT, viewer, gymUuid] as const;

export const gymReportingQueryKey = (
  viewer: string,
  gymUuid: string,
  boardUuid: string | null,
  period: GymStatsPeriod,
) => [...gymReportingQueryPrefix(viewer, gymUuid), boardUuid, period] as const;

export const gymReportingQueryOptions = {
  gcTime: 0,
  refetchOnMount: 'always',
  refetchOnReconnect: 'always',
  refetchOnWindowFocus: 'always',
  networkMode: 'online',
  retry: false,
} as const;

export function isGymReportingAccessError(error: unknown) {
  if (error instanceof GymReportingViewerChangedError || error instanceof GymReportingAccessDeniedError) return true;
  if (hasGraphqlErrorCode(error, 'FORBIDDEN', 'NOT_FOUND', 'UNAUTHENTICATED')) return true;
  const status = (error as { response?: { status?: number } } | null | undefined)?.response?.status;
  return status === 401 || status === 403;
}

export class GymReportingAccessDeniedError extends Error {
  constructor(cause: unknown) {
    super('Gym reporting access was denied', { cause });
  }
}

export class GymReportingViewerChangedError extends Error {
  constructor() {
    super('The signed-in viewer changed while the report was loading');
  }
}

// A successful, same-focus read can support a brief offline report. Every
// receipt expires after five minutes and needs a fresh authorized response.
export const GYM_REPORTING_RECEIPT_MS = 5 * 60_000;

type ReportFilters = {
  queryKey: readonly unknown[];
  exact?: boolean;
  predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
};
type ReportCache = {
  cancelQueries(filters: ReportFilters): Promise<void>;
  getQueryCache(): {
    findAll(filters: ReportFilters): {
      setState(state: { data: undefined; dataUpdatedAt: 0; error: null; status: 'pending' }): void;
    }[];
  };
  getQueryState(queryKey: readonly unknown[]): { dataUpdatedAt: number } | undefined;
  invalidateQueries(filters: ReportFilters): Promise<void>;
};

/** Abort the old request and clear its receipt before a recheck can pause offline. */
export async function retireGymReportingReceipt(cache: ReportCache, filters: ReportFilters) {
  const cancelled = cache.cancelQueries(filters);
  const purge = () => {
    for (const query of cache.getQueryCache().findAll(filters)) {
      query.setState({ data: undefined, dataUpdatedAt: 0, error: null, status: 'pending' });
    }
  };
  purge();
  // A response already settling at the moment of cancellation must be gone
  // before we start a new verification. Preserve the observer's update counts.
  await cancelled;
  purge();
  await cache.invalidateQueries(filters);
}

/** A committed detach invalidates reports for the old gym across cached viewers. */
export function retireGymReportingReceiptsForGym(cache: ReportCache, gymUuid: string) {
  return retireGymReportingReceipt(cache, {
    queryKey: [GYM_REPORTING_QUERY_ROOT],
    predicate: ({ queryKey }) => queryKey[2] === gymUuid,
  });
}

export function scheduleGymReportingReceiptExpiry(
  cache: ReportCache,
  queryKey: readonly unknown[],
  receivedAt: number,
) {
  if (!receivedAt) return;
  const timeout = setTimeout(
    () => {
      if (cache.getQueryState(queryKey)?.dataUpdatedAt === receivedAt) {
        void retireGymReportingReceipt(cache, { queryKey, exact: true });
      }
    },
    Math.max(0, receivedAt + GYM_REPORTING_RECEIPT_MS - Date.now()),
  );
  return () => clearTimeout(timeout);
}

export type GymReportingReadState = 'loading' | 'denied' | 'error' | 'offline' | 'stale' | 'ready';

export function gymReportingReadState({
  data,
  error,
  fetchStatus,
  isFetchedAfterMount,
  offline,
  verifiedAfter = 0,
  dataUpdatedAt,
  now = Date.now(),
}: {
  data?: unknown;
  error: unknown;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  isFetchedAfterMount: boolean;
  offline: boolean;
  verifiedAfter?: number;
  dataUpdatedAt: number;
  now?: number;
}): GymReportingReadState {
  if (isGymReportingAccessError(error)) return 'denied';
  const hasVerifiedData =
    data != null &&
    isFetchedAfterMount &&
    dataUpdatedAt >= verifiedAfter &&
    now < dataUpdatedAt + GYM_REPORTING_RECEIPT_MS;
  if (offline || fetchStatus === 'paused') return hasVerifiedData && !error ? 'stale' : 'offline';
  if (fetchStatus === 'fetching') return 'loading';
  if (error) return 'error';
  return hasVerifiedData ? 'ready' : 'loading';
}

export function gymReportingHasActivity(stats: GymStats) {
  return stats.current.tickCount > 0 || stats.current.displayCount > 0;
}

export function gymReportingHasExactObservations(stats: GymStats) {
  return stats.coverage.firstDisplayAt !== null || stats.coverage.firstTickAt !== null;
}

export function formatGymReportingTime(instant: string, timeZone: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
    new Date(instant),
  );
}

export function formatGymReportingDate(instant: string, timeZone: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(new Date(instant));
}

export function formatGymReportingObservationWindow(stats: GymStats, locale: string) {
  const { coverage, asOf, timeZone } = stats;
  const format = (instant: string) => formatGymReportingTime(instant, timeZone, locale);
  return {
    start: format(coverage.observedSince),
    end: format(asOf),
    firstDisplay: coverage.firstDisplayAt === null ? null : format(coverage.firstDisplayAt),
    firstTick: coverage.firstTickAt === null ? null : format(coverage.firstTickAt),
  };
}

export function gymReportingCountDelta(current: number, previous: number) {
  const diff = current - previous;
  return { diff, direction: diff > 0 ? ('up' as const) : diff < 0 ? ('down' as const) : ('flat' as const) };
}

export function gymReportingAliasSources(boards: GymReportingBoard[]) {
  return boards
    .filter((board) => board.boardType !== 'spray')
    .flatMap((board) =>
      board.configurations
        .filter((configuration) => configuration.uuid !== board.uuid || board.configurations.length === 1)
        .filter(
          (configuration) =>
            configuration.uuid !== board.uuid ||
            boards.some((root) => root.uuid !== board.uuid && root.boardType === board.boardType),
        )
        .map((configuration) => ({
          ...configuration,
          boardType: board.boardType,
          rootUuid: board.uuid === configuration.uuid ? null : board.uuid,
        })),
    );
}

export function gymReportingAliasTargets(
  boards: GymReportingBoard[],
  source: ReturnType<typeof gymReportingAliasSources>[number] | undefined,
) {
  return source
    ? boards.filter(
        (board) => board.boardType === source.boardType && board.uuid !== source.uuid && board.uuid !== source.rootUuid,
      )
    : [];
}
