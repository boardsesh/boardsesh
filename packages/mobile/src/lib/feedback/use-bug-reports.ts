import { type InfiniteData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppBugReportMessageConnection } from '@boardsesh/shared-schema';
import {
  MY_APP_BUG_REPORTS,
  APP_BUG_REPORT,
  APP_BUG_REPORT_MESSAGES,
  SEND_APP_BUG_REPORT_MESSAGE,
  RETRY_APP_BUG_REPORT_MESSAGE,
  type MyAppBugReportsQueryResponse,
  type MyAppBugReportsQueryVariables,
  type AppBugReportQueryResponse,
  type AppBugReportQueryVariables,
  type AppBugReportMessagesQueryResponse,
  type AppBugReportMessagesQueryVariables,
  type SendAppBugReportMessageMutationResponse,
  type SendAppBugReportMessageMutationVariables,
  type RetryAppBugReportMessageMutationResponse,
} from '@boardsesh/graphql/operations';
import {
  MARK_GROUP_NOTIFICATIONS_READ,
  type MarkGroupNotificationsReadMutationResponse,
} from '@boardsesh/graphql/operations/notifications';
import { getHttpClient } from '../graphql/client';
import { bugReportQueryKeys } from './bug-report-query-keys';
import { mergeBugReportMessage } from './bug-report-cache';
import {
  applyNotificationGroupRead,
  GROUPED_NOTIFICATIONS_QUERY_KEY,
  NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY,
} from '../graphql/notification-read-cache';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../auth-store';

const PAGE_SIZE = 20;

export function useMyAppBugReports(accountId: string | undefined, enabled = true) {
  return useInfiniteQuery({
    queryKey: bugReportQueryKeys.list(accountId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const variables: MyAppBugReportsQueryVariables = { input: { limit: PAGE_SIZE, after: pageParam } };
      const response = await getHttpClient().request<MyAppBugReportsQueryResponse>(MY_APP_BUG_REPORTS, variables);
      return response.myAppBugReports;
    },
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.endCursor : undefined),
    enabled: !!accountId && enabled,
    staleTime: 30_000,
  });
}

export function useAppBugReport(accountId: string | undefined, reportId: string, enabled = true) {
  return useQuery({
    queryKey: bugReportQueryKeys.report(accountId, reportId),
    queryFn: async () => {
      const variables: AppBugReportQueryVariables = { id: reportId };
      const response = await getHttpClient().request<AppBugReportQueryResponse>(APP_BUG_REPORT, variables);
      return response.appBugReport;
    },
    enabled: !!accountId && /^\d+$/.test(reportId) && enabled,
    staleTime: 30_000,
  });
}

export function useAppBugReportMessages(accountId: string | undefined, reportId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: bugReportQueryKeys.messages(accountId, reportId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const variables: AppBugReportMessagesQueryVariables = {
        input: { reportId, limit: PAGE_SIZE, before: pageParam },
      };
      const response = await getHttpClient().request<AppBugReportMessagesQueryResponse>(
        APP_BUG_REPORT_MESSAGES,
        variables,
      );
      return response.appBugReportMessages;
    },
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.endCursor : undefined),
    enabled: !!accountId && /^\d+$/.test(reportId) && enabled,
    staleTime: 15_000,
  });
}

export function useRetryAppBugReportMessage(accountId: string, reportId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    onMutate: () =>
      queryClient.cancelQueries({ queryKey: bugReportQueryKeys.messages(accountId, reportId), exact: true }),
    mutationFn: async (id: string) => {
      const response = await getHttpClient().request<RetryAppBugReportMessageMutationResponse>(
        RETRY_APP_BUG_REPORT_MESSAGE,
        { id },
      );
      return response.retryAppBugReportMessage;
    },
    onSuccess: (message) => {
      const queryKey = bugReportQueryKeys.messages(accountId, reportId);
      queryClient.setQueryData<InfiniteData<AppBugReportMessageConnection>>(queryKey, (previous) =>
        mergeBugReportMessage(previous, message),
      );
      void queryClient.invalidateQueries({ queryKey: bugReportQueryKeys.list(accountId), refetchType: 'none' });
    },
  });
}

export function useSendAppBugReportMessage(accountId: string, reportId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Cancel reads that predate the write. A later delivery-event read must
    // survive the mutation response, or its canonical sent state can be lost.
    onMutate: () =>
      queryClient.cancelQueries({ queryKey: bugReportQueryKeys.messages(accountId, reportId), exact: true }),
    mutationFn: async (input: SendAppBugReportMessageMutationVariables['input']) => {
      const response = await getHttpClient().request<SendAppBugReportMessageMutationResponse>(
        SEND_APP_BUG_REPORT_MESSAGE,
        { input },
      );
      return response.sendAppBugReportMessage;
    },
    onSuccess: (message) => {
      const queryKey = bugReportQueryKeys.messages(accountId, reportId);
      queryClient.setQueryData<InfiniteData<AppBugReportMessageConnection>>(queryKey, (previous) =>
        mergeBugReportMessage(previous, message),
      );
      void queryClient.invalidateQueries({
        queryKey: bugReportQueryKeys.report(accountId, reportId),
        refetchType: 'none',
      });
      void queryClient.invalidateQueries({ queryKey: bugReportQueryKeys.list(accountId), refetchType: 'none' });
    },
  });
}

/** Reading through history or a push clears the same bell group as a bell tap. */
export function useMarkAppBugReportRead(reportId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    onMutate: () => ({ credentialGeneration: captureAuthCredentialGeneration() }),
    mutationFn: async () => {
      const response = await getHttpClient().request<MarkGroupNotificationsReadMutationResponse>(
        MARK_GROUP_NOTIFICATIONS_READ,
        {
          type: 'app_feedback_reply',
          entityType: null,
          entityId: reportId,
        },
      );
      return response.markGroupNotificationsRead;
    },
    onSuccess: async (markedCount, _variables, context) => {
      if (!context || !isAuthCredentialGenerationCurrent(context.credentialGeneration)) return;
      const pendingReads = queryClient
        .getQueryCache()
        .findAll({ queryKey: ['notifications'] })
        .filter((query) => query.state.fetchStatus === 'fetching')
        .flatMap((query) => {
          const pendingRequest = query.promise;
          return pendingRequest ? [pendingRequest] : [];
        });
      // Let older reads (including the grouped query's count write) settle.
      // A concurrent response may already include this acknowledgement, so
      // subtracting markedCount from that snapshot could count the read twice.
      await Promise.allSettled(pendingReads);
      if (!isAuthCredentialGenerationCurrent(context.credentialGeneration)) return;
      applyNotificationGroupRead(queryClient, { type: 'app_feedback_reply', entityId: reportId });
      if (markedCount > 0 || pendingReads.length > 0) {
        void queryClient.invalidateQueries({ queryKey: GROUPED_NOTIFICATIONS_QUERY_KEY, refetchType: 'none' });
        await queryClient.invalidateQueries(
          { queryKey: NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, exact: true },
          { cancelRefetch: false },
        );
      }
    },
  });
}
