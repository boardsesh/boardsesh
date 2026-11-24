// Report a problem with a board or a gym listing, and the reports a board's
// creator and its gym's staff review (docs/product/directory-reports.md).
//
// Its own module, like `use-gym-boards`, so the sheets that use it can be tested
// without the hooks barrel, which Vitest cannot import.

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_BOARD_REPORTS,
  REPORT_BOARD,
  REPORT_GYM,
  RESOLVE_DIRECTORY_REPORT,
  UNDO_BOARD_SETUP_CHANGE,
  type GetBoardReportsQueryResponse,
  type ReportBoardMutationResponse,
  type ReportBoardMutationVariables,
  type ReportGymMutationResponse,
  type ReportGymMutationVariables,
  type ResolveDirectoryReportMutationResponse,
  type ResolveDirectoryReportMutationVariables,
  type UndoBoardSetupChangeMutationResponse,
  type UndoBoardSetupChangeMutationVariables,
} from '@boardsesh/graphql/operations/directory-reports';
import { isBoardSetupAlreadyUndoneError, isBoardSetupChangedSinceError } from '@boardsesh/graphql/errors';
import type {
  BoardSetupChangeState,
  GroupedNotification,
  GroupedNotificationConnection,
  ReportBoardInput,
  ReportGymInput,
  ResolveDirectoryReportInput,
} from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';
import { GROUPED_NOTIFICATIONS_QUERY_KEY } from '../notification-read-cache';

/** The waiting and recently closed reports on one board, for its review sheet. */
export function boardReportsQueryKey(boardUuid: string | null) {
  return ['boardReports', boardUuid] as const;
}

/**
 * The reports on a board the viewer can act on: the creator, the gym staff a
 * report went to, global admins. Anyone else gets `[]` from the server.
 */
export function useBoardReports(boardUuid: string | null, enabled = true) {
  return useQuery({
    queryKey: boardReportsQueryKey(boardUuid),
    queryFn: async () =>
      (await getHttpClient().request<GetBoardReportsQueryResponse>(GET_BOARD_REPORTS, { boardUuid })).boardReports,
    enabled: enabled && !!boardUuid,
    // A report closes elsewhere (an edit, the sweep, another staff member), so
    // the sheet reads it fresh every time it opens.
    staleTime: 0,
  });
}

/**
 * Board reads carry `openReportCount` and `viewerHasOpenReport`, so a filed or
 * closed report refreshes every list a board card can sit in.
 */
function invalidateBoardReads(queryClient: ReturnType<typeof useQueryClient>, boardUuid: string) {
  void queryClient.invalidateQueries({ queryKey: ['board', boardUuid] });
  void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
  void queryClient.invalidateQueries({ queryKey: ['nearbyBoards'] });
  void queryClient.invalidateQueries({ queryKey: boardReportsQueryKey(boardUuid) });
}

/**
 * Refreshes every read a board's reports show in: its reports, the board and
 * the lists that carry its report flags. For a caller that closed several
 * reports and must re-read whatever state they ended in, failures included.
 */
export function useRefreshBoardReportReads(): (boardUuid: string) => void {
  const queryClient = useQueryClient();
  return useCallback((boardUuid: string) => invalidateBoardReads(queryClient, boardUuid), [queryClient]);
}

export function useReportBoard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReportBoardInput) =>
      (
        await getHttpClient().request<ReportBoardMutationResponse, ReportBoardMutationVariables>(REPORT_BOARD, {
          input,
        })
      ).reportBoard,
    onSuccess: (_result, input) => invalidateBoardReads(queryClient, input.boardUuid),
  });
}

export function useReportGym() {
  return useMutation({
    mutationFn: async (input: ReportGymInput) =>
      (
        await getHttpClient().request<ReportGymMutationResponse, ReportGymMutationVariables>(REPORT_GYM, {
          input,
        })
      ).reportGym,
  });
}

/** Close one report. Creators and gym staff may only close as `kept`. */
export function useResolveDirectoryReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ResolveDirectoryReportInput) =>
      (
        await getHttpClient().request<ResolveDirectoryReportMutationResponse, ResolveDirectoryReportMutationVariables>(
          RESOLVE_DIRECTORY_REPORT,
          { input },
        )
      ).resolveDirectoryReport,
    onSuccess: (report) => {
      if (report.boardUuid) invalidateBoardReads(queryClient, report.boardUuid);
    },
  });
}

type GroupedNotificationPages = { pages: GroupedNotificationConnection[]; pageParams: unknown[] };

/**
 * Set where a climber-change notice stands in the loaded inbox, so its row
 * drops Undo (or says the board changed since) without reloading the feed.
 */
function setNoticeSetupChangeState(
  queryClient: ReturnType<typeof useQueryClient>,
  notificationUuid: string,
  setupChangeState: BoardSetupChangeState,
) {
  queryClient.setQueriesData<GroupedNotificationPages>({ queryKey: GROUPED_NOTIFICATIONS_QUERY_KEY }, (previous) =>
    previous
      ? {
          ...previous,
          pages: previous.pages.map((page) => ({
            ...page,
            groups: page.groups.map((group) =>
              group.uuid === notificationUuid && group.directoryNotice
                ? { ...group, directoryNotice: { ...group.directoryNotice, setupChangeState } }
                : group,
            ),
          })),
        }
      : previous,
  );
}

/**
 * Put back the setup a climber's suggestion replaced, from the
 * `board_setup_changed_by_climber` notice. The server refuses with:
 *
 * - `BOARD_SETUP_CHANGED_SINCE` once the board changed again: the row moves
 *   to `CHANGED_SINCE`.
 * - `BOARD_SETUP_ALREADY_UNDONE` once someone undid it first: the row moves to
 *   `UNDONE` and the board is read again, since the old setup is back.
 * - `NOT_FOUND` once this viewer may no longer undo it (the board moved gyms or
 *   went private, or their role at the gym ended). The row's state stays; the
 *   caller says so.
 *
 * Returns `mutateAsync`, which React Query keeps stable, so the inbox can hand
 * it to every memoised row.
 */
export function useUndoBoardSetupChange() {
  const queryClient = useQueryClient();
  const { mutateAsync } = useMutation({
    // Fail at once offline, like a follow request's answer, so the row says
    // to try again instead of spinning on a paused mutation.
    networkMode: 'always',
    mutationFn: async ({
      eventId,
    }: {
      eventId: string;
      notification: Pick<GroupedNotification, 'uuid' | 'directoryNotice'>;
    }) =>
      (
        await getHttpClient().request<UndoBoardSetupChangeMutationResponse, UndoBoardSetupChangeMutationVariables>(
          UNDO_BOARD_SETUP_CHANGE,
          { eventId },
        )
      ).undoBoardSetupChange,
    onSuccess: (board, { notification }) => {
      setNoticeSetupChangeState(queryClient, notification.uuid, 'UNDONE');
      invalidateBoardReads(queryClient, board.uuid);
    },
    onError: (error, { notification }) => {
      if (isBoardSetupChangedSinceError(error)) {
        setNoticeSetupChangeState(queryClient, notification.uuid, 'CHANGED_SINCE');
      } else if (isBoardSetupAlreadyUndoneError(error)) {
        setNoticeSetupChangeState(queryClient, notification.uuid, 'UNDONE');
        const boardUuid = notification.directoryNotice?.boardUuid;
        if (boardUuid) invalidateBoardReads(queryClient, boardUuid);
      }
    },
  });
  return mutateAsync;
}
