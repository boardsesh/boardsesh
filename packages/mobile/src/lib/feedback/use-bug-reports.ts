import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

const PAGE_SIZE = 20;

export function useMyAppBugReports(accountId: string | undefined) {
  return useInfiniteQuery({
    queryKey: bugReportQueryKeys.list(accountId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const variables: MyAppBugReportsQueryVariables = { input: { limit: PAGE_SIZE, after: pageParam } };
      const response = await getHttpClient().request<MyAppBugReportsQueryResponse>(MY_APP_BUG_REPORTS, variables);
      return response.myAppBugReports;
    },
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.endCursor : undefined),
    enabled: !!accountId,
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
    refetchInterval: 15_000,
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
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.messages.some((message) => message.deliveryStatus === 'pending'))
        ? 5_000
        : 15_000,
  });
}

export function useRetryAppBugReportMessage(accountId: string, reportId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await getHttpClient().request<RetryAppBugReportMessageMutationResponse>(
        RETRY_APP_BUG_REPORT_MESSAGE,
        { id },
      );
      return response.retryAppBugReportMessage;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bugReportQueryKeys.messages(accountId, reportId) });
      void queryClient.invalidateQueries({ queryKey: bugReportQueryKeys.list(accountId) });
    },
  });
}

export function useSendAppBugReportMessage(accountId: string, reportId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SendAppBugReportMessageMutationVariables['input']) => {
      const response = await getHttpClient().request<SendAppBugReportMessageMutationResponse>(
        SEND_APP_BUG_REPORT_MESSAGE,
        { input },
      );
      return response.sendAppBugReportMessage;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bugReportQueryKeys.messages(accountId, reportId) });
      void queryClient.invalidateQueries({ queryKey: bugReportQueryKeys.report(accountId, reportId) });
      void queryClient.invalidateQueries({ queryKey: bugReportQueryKeys.list(accountId) });
    },
  });
}

/** Reading through history or a push clears the same bell group as a bell tap. */
export function useMarkAppBugReportRead(reportId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      getHttpClient().request<MarkGroupNotificationsReadMutationResponse>(MARK_GROUP_NOTIFICATIONS_READ, {
        type: 'app_feedback_reply',
        entityType: null,
        entityId: reportId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
