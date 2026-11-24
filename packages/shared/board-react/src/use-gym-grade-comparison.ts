import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  hashKey,
  notifyManager,
  onlineManager,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import {
  GET_GYM_GRADE_COLLECTION_OPTIONS,
  GET_GYM_GRADE_COMPARISON,
  GymReportingAccessDeniedError,
  SET_GYM_GRADE_COLLECTION,
  gymReportingQueryOptions,
  gymReportingQueryPrefix,
  gymReportingReadState,
  hasGraphqlErrorCode,
  isGymReportingAccessError,
  retireGymReportingReceipt,
  scheduleGymReportingReceiptExpiry,
} from '@boardsesh/graphql';
import type {
  GymGradeCollectionOptionsInput,
  GymGradeCollectionPage,
  GymGradeComparison,
  GymStatsInput,
  SetGymGradeCollectionInput,
} from '@boardsesh/shared-schema';

type GradeVariables = { input: GymStatsInput | GymGradeCollectionOptionsInput | SetGymGradeCollectionInput };

export type GymGradeRequest = <Result>(
  document: string,
  variables: GradeVariables,
  signal?: AbortSignal,
) => Promise<Result>;

type ReportRequest = {
  viewerId: string;
  gymUuid: string;
  /** Existing overview may still be keyed by the UUID before canonicalization. */
  overviewGymUuid?: string;
  request: GymGradeRequest;
};

const COMPARISON = 'grade-comparison';
const COLLECTION_OPTIONS = 'grade-collection-options';

function useGymAccessPrefixes(viewerId: string, gymUuid: string, overviewGymUuid?: string) {
  return useMemo(
    () => [...new Set([gymUuid, overviewGymUuid ?? gymUuid])].map((uuid) => gymReportingQueryPrefix(viewerId, uuid)),
    [viewerId, gymUuid, overviewGymUuid],
  );
}

/** Keep the reason and discard all prior evidence without starting a retry loop. */
function denyGymReceipts(client: QueryClient, prefixes: readonly QueryKey[], error: unknown, rejectingKey?: QueryKey) {
  const rejectingHash = rejectingKey ? hashKey(rejectingKey) : null;
  const denial = error instanceof Error ? error : new GymReportingAccessDeniedError(error);
  notifyManager.batch(() => {
    for (const prefix of prefixes) {
      for (const query of client.getQueryCache().findAll({ queryKey: prefix })) {
        // TanStack's reverting cancellation restores old state synchronously.
        // Erase that state immediately afterward. The rejecting read itself
        // still needs to settle normally and publish its original error.
        if (query.queryHash !== rejectingHash) void query.cancel({ revert: true });
        query.setState({ data: undefined, dataUpdatedAt: 0, error: denial, status: 'error', fetchStatus: 'idle' });
      }
    }
  });
}

let reconnectAt = 0;
function subscribeOnline(notify: () => void) {
  return onlineManager.subscribe((online) => {
    if (online) reconnectAt = Date.now();
    notify();
  });
}

function readConnectivity() {
  return onlineManager.isOnline() ? reconnectAt : -1;
}

function useVerifiedGymGradeRead<Data>(
  queryKey: readonly (string | null | undefined)[],
  accessPrefixes: readonly QueryKey[],
  queryFn: (options: { signal: AbortSignal }) => Promise<Data>,
) {
  const queryClient = useQueryClient();
  const connectivity = useSyncExternalStore(subscribeOnline, readConnectivity, () => 0);
  const query = useQuery({
    ...gymReportingQueryOptions,
    queryKey,
    queryFn: async ({ signal }) => {
      try {
        return await queryFn({ signal });
      } catch (error) {
        if (!signal.aborted && isGymReportingAccessError(error)) {
          denyGymReceipts(queryClient, accessPrefixes, error, queryKey);
        }
        throw error;
      }
    },
    meta: { persist: false },
  });
  const state = gymReportingReadState({
    ...query,
    offline: connectivity < 0,
    verifiedAfter: Math.max(connectivity, 0),
  });
  const { dataUpdatedAt } = query;
  useEffect(
    () => scheduleGymReportingReceiptExpiry(queryClient, queryKey, dataUpdatedAt),
    [queryClient, queryKey, dataUpdatedAt],
  );
  useEffect(() => {
    if (isGymReportingAccessError(query.error)) return;
    if (connectivity < 0) {
      void retireGymReportingReceipt(queryClient, { queryKey, exact: true });
    } else if (query.error) {
      queryClient.getQueryCache().find({ queryKey, exact: true })?.setState({ data: undefined, dataUpdatedAt: 0 });
    }
  }, [connectivity, query.error, queryClient, queryKey]);
  return {
    data: state === 'ready' ? query.data : undefined,
    state: state === 'stale' ? 'offline' : state,
    error: query.error,
    retry: () => void query.refetch(),
  };
}

export const gymGradeComparisonQueryKey = (viewerId: string, { gymUuid, boardUuid, period }: GymStatsInput) =>
  [...gymReportingQueryPrefix(viewerId, gymUuid), COMPARISON, boardUuid ?? null, period] as const;

export function useGymGradeComparison(
  { viewerId, gymUuid, overviewGymUuid, request }: ReportRequest,
  boardUuid: GymStatsInput['boardUuid'],
  period: GymStatsInput['period'],
) {
  const input = { gymUuid, boardUuid, period };
  const queryKey = useMemo(
    () => gymGradeComparisonQueryKey(viewerId, { gymUuid, boardUuid, period }),
    [viewerId, gymUuid, boardUuid, period],
  );
  const accessPrefixes = useGymAccessPrefixes(viewerId, gymUuid, overviewGymUuid);
  return useVerifiedGymGradeRead(queryKey, accessPrefixes, async ({ signal }) => {
    const response = await request<{ gymGradeComparison: GymGradeComparison }>(
      GET_GYM_GRADE_COMPARISON,
      { input },
      signal,
    );
    return response.gymGradeComparison;
  });
}

export function useGymGradeCollectionPicker(
  { viewerId, gymUuid, overviewGymUuid, request }: ReportRequest,
  boardUuid: string,
) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1) ?? null;
  const prefix = useMemo(() => gymReportingQueryPrefix(viewerId, gymUuid), [viewerId, gymUuid]);
  const queryKey = useMemo(
    () => [...prefix, COLLECTION_OPTIONS, boardUuid, name, cursor] as const,
    [prefix, boardUuid, name, cursor],
  );
  const accessPrefixes = useGymAccessPrefixes(viewerId, gymUuid, overviewGymUuid);
  const results = useVerifiedGymGradeRead(queryKey, accessPrefixes, async ({ signal }) => {
    const response = await request<{ gymGradeCollectionOptions: GymGradeCollectionPage }>(
      GET_GYM_GRADE_COLLECTION_OPTIONS,
      { input: { gymUuid, boardUuid, search: name, cursor } },
      signal,
    );
    return response.gymGradeCollectionOptions;
  });
  const retireComparison = () =>
    Promise.all([
      retireGymReportingReceipt(queryClient, { queryKey: [...prefix, COMPARISON] }),
      retireGymReportingReceipt(queryClient, { queryKey: [...prefix, COLLECTION_OPTIONS] }),
    ]);
  const mutation = useMutation({
    mutationFn: async (playlistUuid: string | null) => {
      const response = await request<{ setGymGradeCollection: boolean }>(SET_GYM_GRADE_COLLECTION, {
        input: { gymUuid, boardUuid, playlistUuid },
      });
      if (!response.setGymGradeCollection) throw new Error('Grade comparison collection was not saved');
    },
    onSuccess: async () => {
      await retireComparison();
    },
    onError: (error) => {
      if (isGymReportingAccessError(error)) {
        denyGymReceipts(queryClient, accessPrefixes, error);
      } else if (hasGraphqlErrorCode(error, 'COLLECTION_UNAVAILABLE')) {
        // A vanished or incompatible choice still permits the staff overview.
        // Revalidate the two receipts that can name a playlist and keep the
        // mounted picker so its safe recovery message is visible.
        void retireComparison();
      }
    },
  });
  const nextCursor = results.data?.nextCursor;
  return {
    ...results,
    search,
    setSearch,
    searchNow: () => {
      if (search.trim() === name && cursor === null) results.retry();
      setName(search.trim());
      setCursors([]);
    },
    canGoBack: cursor !== null,
    goBack: () => setCursors((existing) => existing.slice(0, -1)),
    goNext: nextCursor ? () => setCursors((existing) => [...existing, nextCursor]) : undefined,
    save: mutation.mutateAsync,
    saving: mutation.isPending,
    saveError: mutation.error,
  };
}
