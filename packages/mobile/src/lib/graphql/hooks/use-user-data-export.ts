import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import { onlineManager, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { UserDataExportActionError } from '../../user-data-export-action';
import { useHttpMutation } from '../use-http-mutation';
import { useHttpQueryScope } from '../use-http-query-scope';
import { isGraphqlRateLimitedError } from '../extract-error-message';

export { UserDataExportActionError } from '../../user-data-export-action';

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
  const httpScope = useHttpQueryScope();
  const viewCache = useMemo(() => httpScope.cache(queryClient), [httpScope, queryClient]);
  const credentialGeneration = captureAuthCredentialGeneration();
  const accountScope = `${userId}:${credentialGeneration}:${boardType}`;
  const scope = httpScope.scoped ? `${accountScope}:${httpScope.scope}` : accountScope;
  const [periodAnchor, setPeriodAnchor] = useState<{ scope: string; period: string | null }>({ scope, period: null });
  const period = periodAnchor.scope === scope ? periodAnchor.period : null;
  const queryKey = userDataExportQueryKey(userId, credentialGeneration, boardType, period);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const downloadControllers = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    const controllers = downloadControllers.current;
    return () => {
      mounted.current = false;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, [scope]);
  const pollingDeadline = useRef<{ scope: string; at: number } | null>(null);
  const manualRefresh = useRef<{ scope: string } | null>(null);
  const [pollDeadline, setPollDeadline] = useState<{ scope: string; reached: boolean }>({ scope, reached: false });
  const pollLimitReached = pollDeadline.scope === scope && pollDeadline.reached;
  const active = isFocused && !isBackgrounded && !isOffline;

  const statusQuery = useQuery({
    queryKey: httpScope.key(queryKey),
    queryFn: async ({ signal }) => {
      httpScope.assertView();
      requireCurrentSession(credentialGeneration);
      if (
        manualRefresh.current?.scope !== scope &&
        pollingDeadline.current?.scope === scope &&
        Date.now() >= pollingDeadline.current.at
      ) {
        // This polling cap may return already-owned metadata; it is not a new
        // network delivery and cannot authorize a download or mutation.
        const cachedStatus = viewCache.getQueryData<UserDataExportStatus>(queryKey);
        if (cachedStatus) return cachedStatus;
      }
      const operation = httpScope.create({ signal });
      const response = await operation.request<GetUserDataExportResponse, GetUserDataExportVariables>(
        GET_USER_DATA_EXPORT,
        period ? { boardType, period } : { boardType },
      );
      requireCurrentSession(credentialGeneration);
      operation.assertDeliveries();
      return response.userDataExport;
    },
    enabled: active && !pollLimitReached && httpScope.isReady(),
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
    if (!generatingPeriod || period === generatingPeriod || !httpScope.isReady()) return;
    const exportStatus = statusQuery.data;
    viewCache.setQueryData(
      userDataExportQueryKey(userId, credentialGeneration, boardType, generatingPeriod),
      exportStatus,
    );
    setPeriodAnchor({ scope, period: generatingPeriod });
  }, [
    generatingPeriod,
    period,
    scope,
    statusQuery.data,
    httpScope,
    viewCache,
    userId,
    credentialGeneration,
    boardType,
  ]);

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
    httpScope.assertView();
    requireCurrentSession(credentialGeneration);
    if (period && statusQuery.data?.status === 'ready' && Date.parse(statusQuery.data.refreshAt) <= Date.now()) {
      // Keep a Sunday request downloadable on Monday; an explicit refresh then selects the new week.
      viewCache.removeQueries({
        queryKey: userDataExportQueryKey(userId, credentialGeneration, boardType),
        exact: true,
      });
      setPeriodAnchor({ scope, period: null });
      return;
    }
    const attempt = { scope };
    manualRefresh.current = attempt;
    try {
      const result = await refetchStatus();
      httpScope.assertView();
      requireCurrentSession(credentialGeneration);
      return result;
    } finally {
      if (manualRefresh.current === attempt) manualRefresh.current = null;
    }
  }, [refetchStatus, period, statusQuery.data, httpScope, viewCache, userId, credentialGeneration, boardType, scope]);

  const requestMutation = useHttpMutation({
    // Guard explicitly rather than queue a paused generation for a later session/reconnect.
    networkMode: 'always',
    retry: false,
    onMutate: (request: ExportActionScope & { anchorPeriod: string | null }) =>
      viewCache.cancelQueries({
        queryKey: userDataExportQueryKey(
          request.userId,
          request.credentialGeneration,
          request.boardType,
          request.anchorPeriod,
        ),
      }),
    mutationFn: async (request: ExportActionScope & { anchorPeriod: string | null }, operation) => {
      requireCurrentSession(request.credentialGeneration);
      if (currentScope.current !== request.scope) throw new UserDataExportActionError('session_changed');
      const response = await operation.request<RequestUserDataExportResponse, UserDataExportVariables>(
        REQUEST_USER_DATA_EXPORT,
        { boardType: request.boardType },
      );
      requireCurrentSession(request.credentialGeneration);
      return response.requestUserDataExport;
    },
    onSuccess: (exportStatus, request, _context, operation) => {
      if (currentScope.current === request.scope && isAuthCredentialGenerationCurrent(request.credentialGeneration)) {
        operation
          .cache(queryClient)
          .setQueryData<UserDataExportStatus>(
            userDataExportQueryKey(
              request.userId,
              request.credentialGeneration,
              request.boardType,
              exportStatus.period,
            ),
            exportStatus,
          );
        setPeriodAnchor({ scope: request.scope, period: exportStatus.period });
      }
    },
  });

  const downloadMutation = useHttpMutation({
    networkMode: 'always',
    retry: false,
    mutationFn: async (request: ExportActionScope & { period: string; format: UserDataExportFormat }, operation) => {
      requireCurrentSession(request.credentialGeneration);
      const isCurrentOwner = () =>
        mounted.current &&
        currentScope.current === request.scope &&
        isAuthCredentialGenerationCurrent(request.credentialGeneration);
      if (!isCurrentOwner()) throw new UserDataExportActionError('session_changed');
      const controller = new AbortController();
      downloadControllers.current.add(controller);
      const isCurrent = () => {
        if (!isCurrentOwner() || controller.signal.aborted) return false;
        try {
          operation.assertDeliveries();
          return true;
        } catch {
          return false;
        }
      };
      try {
        const response = await operation.request<GetUserDataExportDownloadResponse, UserDataExportDownloadVariables>({
          document: GET_USER_DATA_EXPORT_DOWNLOAD,
          variables: {
            boardType: request.boardType,
            period: request.period,
            format: request.format,
          },
          signal: controller.signal,
        });
        requireCurrentSession(request.credentialGeneration);
        if (!isCurrent() || controller.signal.aborted) throw new UserDataExportActionError('session_changed');
        await openUserDataExportDownload({
          url: response.userDataExportDownload.url,
          filename: response.userDataExportDownload.filename,
          credentialGeneration: request.credentialGeneration,
          isCurrent,
          signal: controller.signal,
        });
        if (!isCurrent()) throw new UserDataExportActionError('session_changed');
        // Signed URLs remain local to this call, outside mutation variables/data.
      } catch (error) {
        if (!isCurrentOwner() || controller.signal.aborted) throw new UserDataExportActionError('session_changed');
        if (error instanceof UserDataExportActionError) throw error;
        // graphql-request may retain a partial signed link in response.data,
        // body and message. Preserve only the existing retry classification.
        const refusal = new Error('User data export link unavailable');
        if (isGraphqlRateLimitedError(error)) Object.assign(refusal, { extensions: { code: 'RATE_LIMITED' } });
        throw refusal;
      } finally {
        downloadControllers.current.delete(controller);
      }
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
      mutateWithReceipt: (options?: { signal?: AbortSignal }) =>
        requestMutation.mutateWithReceipt(
          { userId, boardType, credentialGeneration, scope, anchorPeriod: period },
          options,
        ),
    },
    downloadMutation: {
      ...downloadMutation,
      mutateAsync: (download: { period: string; format: UserDataExportFormat }) =>
        downloadMutation.mutateAsync({ ...download, userId, boardType, credentialGeneration, scope }),
      mutateWithReceipt: (
        download: { period: string; format: UserDataExportFormat },
        options?: { signal?: AbortSignal },
      ) => downloadMutation.mutateWithReceipt({ ...download, userId, boardType, credentialGeneration, scope }, options),
    },
    pollLimitReached,
    isOffline,
    refresh,
  };
}
