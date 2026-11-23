import { useEffect, useSyncExternalStore } from 'react';
import { focusManager, onlineManager, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_GYM_STATS,
  GymReportingViewerChangedError,
  gymReportingQueryKey,
  gymReportingQueryOptions,
  gymReportingQueryPrefix,
  gymReportingReadState,
  retireGymReportingReceipt,
  scheduleGymReportingReceiptExpiry,
  type GetGymStatsQueryResponse,
  type GetGymStatsQueryVariables,
} from '@boardsesh/graphql';
import type { GymStatsPeriod } from '@boardsesh/shared-schema';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../../auth-store';
import { readLocalUserId } from '../../local-user-id';
import { getHttpClient } from '../client';

let reconnectAt = 0;

function subscribeOnline(onChange: () => void) {
  return onlineManager.subscribe((online) => {
    if (online) reconnectAt = Date.now();
    onChange();
  });
}

function readConnectivity() {
  return onlineManager.isOnline() ? reconnectAt : -1;
}

function subscribeFocus(onChange: () => void) {
  return focusManager.subscribe(onChange);
}

export function useGymReportingForeground() {
  return useSyncExternalStore(
    subscribeFocus,
    () => focusManager.isFocused(),
    () => true,
  );
}

export async function requestForGymViewer<Result>(viewerId: string, request: () => Promise<Result>): Promise<Result> {
  const generation = captureAuthCredentialGeneration();
  if ((await readLocalUserId()) !== viewerId || !isAuthCredentialGenerationCurrent(generation)) {
    throw new GymReportingViewerChangedError();
  }
  const result = await request();
  if (!isAuthCredentialGenerationCurrent(generation)) throw new GymReportingViewerChangedError();
  return result;
}

export function useGymReporting(viewerId: string, gymUuid: string, boardUuid: string | null, period: GymStatsPeriod) {
  const reconnect = useSyncExternalStore(subscribeOnline, readConnectivity, () => 0);
  const queryClient = useQueryClient();
  const query = useQuery({
    ...gymReportingQueryOptions,
    queryKey: gymReportingQueryKey(viewerId, gymUuid, boardUuid, period),
    queryFn: async ({ signal }) => {
      const response = await requestForGymViewer(viewerId, () =>
        getHttpClient().request<GetGymStatsQueryResponse, GetGymStatsQueryVariables>({
          document: GET_GYM_STATS,
          signal,
          variables: { input: { gymUuid, boardUuid, period } },
        }),
      );
      return response.gymStats;
    },
  });
  const state = gymReportingReadState({ ...query, offline: reconnect < 0, verifiedAfter: Math.max(0, reconnect) });

  const { dataUpdatedAt } = query;
  useEffect(
    () =>
      scheduleGymReportingReceiptExpiry(
        queryClient,
        gymReportingQueryKey(viewerId, gymUuid, boardUuid, period),
        dataUpdatedAt,
      ),
    [queryClient, viewerId, gymUuid, boardUuid, period, dataUpdatedAt],
  );

  useEffect(() => {
    if (state !== 'denied') return;
    const queryKey = gymReportingQueryKey(viewerId, gymUuid, boardUuid, period);
    // Keep the error for this mounted observer and drop every report payload in this gym.
    queryClient.getQueryCache().find({ queryKey, exact: true })?.setState({ data: undefined, dataUpdatedAt: 0 });
    queryClient.removeQueries({ queryKey: gymReportingQueryPrefix(viewerId, gymUuid), type: 'inactive' });
  }, [state, queryClient, viewerId, gymUuid, boardUuid, period]);

  function retireReport() {
    return retireGymReportingReceipt(queryClient, { queryKey: gymReportingQueryPrefix(viewerId, gymUuid) });
  }

  return { ...query, state, retireReport };
}
