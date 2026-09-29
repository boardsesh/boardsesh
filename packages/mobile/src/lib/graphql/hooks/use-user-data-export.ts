import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import { onlineManager, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardName, UserDataExportFormat, UserDataExportStatus } from '@boardsesh/shared-schema';
import {
  GET_USER_DATA_EXPORT,
  GET_USER_DATA_EXPORT_DOWNLOAD,
  REQUEST_USER_DATA_EXPORT,
  type GetUserDataExportDownloadResponse,
  type GetUserDataExportResponse,
  type GetUserDataExportVariables,
  type RequestUserDataExportResponse,
  type UserDataExportDownloadVariables,
  type UserDataExportVariables,
} from '@boardsesh/graphql/operations/user-data-export';
import { useIsOffline } from '../../../hooks/use-is-offline';
import { useIsAppBackgrounded } from '../../app-visibility';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../../auth-store';
import { openUserDataExportDownload } from '../../user-data-export-download';
import { getHttpClient } from '../client';

export const USER_DATA_EXPORT_POLL_MS = 5_000;
export const USER_DATA_EXPORT_POLL_LIMIT_MS = 5 * 60_000;

export function userDataExportQueryKey(
  userId: string,
  credentialGeneration: number,
  boardType: BoardName,
  period: string | null = null,
) {
  return ['userDataExport', userId, credentialGeneration, boardType, period] as const;
}

export class UserDataExportActionError extends Error {
  constructor(public readonly reason: 'session_changed' | 'offline' | 'browser_failed') {
    super(`User data export action: ${reason}`);
  }
}

type ExportActionScope = {
  userId: string;
  boardType: BoardName;
  credentialGeneration: number;
  scope: string;
};

function requireCurrentSession(credentialGeneration: number): void {
  if (!isAuthCredentialGenerationCurrent(credentialGeneration)) {
    throw new UserDataExportActionError('session_changed');
  }
  if (!onlineManager.isOnline()) throw new UserDataExportActionError('offline');
}

/** Account-scoped metadata only. Signed download URLs never enter query/mutation data. */
export function useUserDataExport(userId: string, boardType: BoardName) {
  const isFocused = useIsFocused();
  const isOffline = useIsOffline();
  const isBackgrounded = useIsAppBackgrounded();
  const queryClient = useQueryClient();
  const credentialGeneration = captureAuthCredentialGeneration();
  const scope = `${userId}:${credentialGeneration}:${boardType}`;
  const [periodAnchor, setPeriodAnchor] = useState<{ scope: string; period: string | null }>({ scope, period: null });
  const period = periodAnchor.scope === scope ? periodAnchor.period : null;
  const queryKey = userDataExportQueryKey(userId, credentialGeneration, boardType, period);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const pollingDeadline = useRef<{ scope: string; at: number } | null>(null);
  const manualRefresh = useRef(false);
  const [pollDeadline, setPollDeadline] = useState<{ scope: string; reached: boolean }>({ scope, reached: false });
  const pollLimitReached = pollDeadline.scope === scope && pollDeadline.reached;
  const active = isFocused && !isBackgrounded && !isOffline;

  const statusQuery = useQuery({
    queryKey,
    queryFn: async () => {
      requireCurrentSession(credentialGeneration);
      if (
        !manualRefresh.current &&
        pollingDeadline.current?.scope === scope &&
        Date.now() >= pollingDeadline.current.at
      ) {
        const cachedStatus = queryClient.getQueryData<UserDataExportStatus>(queryKey);
        if (cachedStatus) return cachedStatus;
      }
      const response = await getHttpClient().request<GetUserDataExportResponse, GetUserDataExportVariables>(
        GET_USER_DATA_EXPORT,
        period ? { boardType, period } : { boardType },
      );
      requireCurrentSession(credentialGeneration);
      return response.userDataExport;
    },
    enabled: active && !pollLimitReached,
    networkMode: 'online',
    retry: false,
    staleTime: USER_DATA_EXPORT_POLL_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      active && !pollLimitReached && query.state.data?.status === 'generating' ? USER_DATA_EXPORT_POLL_MS : false,
  });

  const generating = statusQuery.data?.status === 'generating';
  const generatingPeriod = generating ? statusQuery.data?.period : null;
  useEffect(() => {
    if (!generatingPeriod || period === generatingPeriod) return;
    const exportStatus = statusQuery.data;
    queryClient.setQueryData(
      userDataExportQueryKey(userId, credentialGeneration, boardType, generatingPeriod),
      exportStatus,
    );
    setPeriodAnchor({ scope, period: generatingPeriod });
  }, [generatingPeriod, period, scope, statusQuery.data, queryClient, userId, credentialGeneration, boardType]);

  useEffect(() => {
    setPollDeadline({ scope, reached: false });
    pollingDeadline.current = null;
    if (!generating) return;
    pollingDeadline.current = { scope, at: Date.now() + USER_DATA_EXPORT_POLL_LIMIT_MS };
    // The wall-clock cap survives blur/background. Refocusing cannot restart an endless poll.
    const timer = setTimeout(() => setPollDeadline({ scope, reached: true }), USER_DATA_EXPORT_POLL_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [scope, generating]);

  const refetchStatus = statusQuery.refetch;
  const refresh = useCallback(async () => {
    if (period && statusQuery.data?.status === 'ready' && Date.parse(statusQuery.data.refreshAt) <= Date.now()) {
      // Keep a Sunday request downloadable on Monday; an explicit refresh then selects the new week.
      queryClient.removeQueries({
        queryKey: userDataExportQueryKey(userId, credentialGeneration, boardType),
        exact: true,
      });
      setPeriodAnchor({ scope, period: null });
      return;
    }
    manualRefresh.current = true;
    try {
      return await refetchStatus();
    } finally {
      manualRefresh.current = false;
    }
  }, [refetchStatus, period, statusQuery.data, queryClient, userId, credentialGeneration, boardType, scope]);

  const requestMutation = useMutation({
    // Guard explicitly rather than queue a paused generation for a later session/reconnect.
    networkMode: 'always',
    retry: false,
    onMutate: (request: ExportActionScope & { anchorPeriod: string | null }) =>
      queryClient.cancelQueries({
        queryKey: userDataExportQueryKey(
          request.userId,
          request.credentialGeneration,
          request.boardType,
          request.anchorPeriod,
        ),
      }),
    mutationFn: async (request: ExportActionScope & { anchorPeriod: string | null }) => {
      requireCurrentSession(request.credentialGeneration);
      if (currentScope.current !== request.scope) throw new UserDataExportActionError('session_changed');
      const response = await getHttpClient().request<RequestUserDataExportResponse, UserDataExportVariables>(
        REQUEST_USER_DATA_EXPORT,
        { boardType: request.boardType },
      );
      requireCurrentSession(request.credentialGeneration);
      return response.requestUserDataExport;
    },
    onSuccess: (exportStatus, request) => {
      if (currentScope.current === request.scope && isAuthCredentialGenerationCurrent(request.credentialGeneration)) {
        queryClient.setQueryData<UserDataExportStatus>(
          userDataExportQueryKey(request.userId, request.credentialGeneration, request.boardType, exportStatus.period),
          exportStatus,
        );
        setPeriodAnchor({ scope: request.scope, period: exportStatus.period });
      }
    },
  });

  const downloadMutation = useMutation({
    networkMode: 'always',
    retry: false,
    mutationFn: async (request: ExportActionScope & { period: string; format: UserDataExportFormat }) => {
      requireCurrentSession(request.credentialGeneration);
      if (currentScope.current !== request.scope) throw new UserDataExportActionError('session_changed');
      const response = await getHttpClient().request<
        GetUserDataExportDownloadResponse,
        UserDataExportDownloadVariables
      >(GET_USER_DATA_EXPORT_DOWNLOAD, {
        boardType: request.boardType,
        period: request.period,
        format: request.format,
      });
      requireCurrentSession(request.credentialGeneration);
      if (currentScope.current !== request.scope) throw new UserDataExportActionError('session_changed');
      const opened = await openUserDataExportDownload(response.userDataExportDownload.url);
      if (!opened) throw new UserDataExportActionError('browser_failed');
      // No signed URL is returned or persisted; every tap obtains a fresh five-minute link.
    },
  });

  const resetRequest = requestMutation.reset;
  const resetDownload = downloadMutation.reset;
  useEffect(() => {
    resetRequest();
    resetDownload();
  }, [scope, resetRequest, resetDownload]);

  return {
    statusQuery,
    requestMutation: {
      ...requestMutation,
      mutateAsync: () =>
        requestMutation.mutateAsync({ userId, boardType, credentialGeneration, scope, anchorPeriod: period }),
    },
    downloadMutation: {
      ...downloadMutation,
      mutateAsync: (download: { period: string; format: UserDataExportFormat }) =>
        downloadMutation.mutateAsync({ ...download, userId, boardType, credentialGeneration, scope }),
    },
    pollLimitReached,
    isOffline,
    refresh,
  };
}
