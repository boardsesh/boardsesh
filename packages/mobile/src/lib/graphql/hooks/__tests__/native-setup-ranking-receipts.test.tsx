// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { gymClimbRankingsQueryKey } from '@boardsesh/board-react';
import { gymReportingQueryKey } from '@boardsesh/graphql';
import { GET_BOARD } from '@boardsesh/graphql/operations/boards';
import { REPORT_BOARD, UNDO_BOARD_SETUP_CHANGE } from '@boardsesh/graphql/operations/directory-reports';
import type {
  DirectoryReportSubmitResult,
  GroupedNotification,
  ReportBoardInput,
  UserBoard,
} from '@boardsesh/shared-schema';
import { useUndoSetupChange } from '../../../../components/notifications/use-undo-setup-change';
import { getGymRankingRetirementGeneration } from '../../../privacy/privacy-cache';
import { useReportBoard } from '../use-directory-reports';

const request = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
const applyChangedBoard = vi.hoisted(() => vi.fn());

vi.mock('../../client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../../../providers/dialog-provider', () => ({ useConfirm: () => confirm }));
vi.mock('../../../boards/use-apply-changed-board', () => ({ useApplyChangedBoard: () => applyChangedBoard }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const viewer = 'viewer-1';
const gym = 'gym-1';
const boardUuid = 'board-1';
const overviewKey = gymReportingQueryKey(viewer, gym, boardUuid, 'week');
const rankingsKey = gymClimbRankingsQueryKey(
  viewer,
  1,
  { gymUuid: gym, boardUuid, period: 'week', mode: 'MOST_SENT' },
  1,
);
const overviewReceipt = { boardUuid };
const rankingsReceipt = { report: { rows: [{ name: 'Warmup', angle: 40 }] } };
const restored = { uuid: boardUuid } as UserBoard;
const suggestedSetup = { layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
const input = { boardUuid, reason: 'wrong_setup', suggestedSetup } satisfies ReportBoardInput;
const notification: GroupedNotification = {
  uuid: 'notice-1',
  type: 'board_setup_changed_by_climber',
  entityType: 'board',
  entityId: boardUuid,
  actorCount: 0,
  actors: [],
  isRead: false,
  createdAt: '2026-11-24T10:00:00.000Z',
  directoryNotice: {
    targetKind: 'board',
    boardUuid,
    isReminder: false,
    recipientIsCreator: true,
    setupChangeEventId: '42',
    setupChangeState: 'LIVE',
  },
};

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

function refusal(code: string, reason?: string) {
  return { response: { errors: [{ message: code, extensions: { code, reason } }] } };
}

function submitted(setupOutcome: DirectoryReportSubmitResult['setupOutcome']) {
  return {
    reportBoard: {
      status: 'created',
      reportUuid: 'report-1',
      routedTo: [],
      otherReporterCount: 0,
      setupOutcome,
      board: null,
    },
  };
}

async function report(variables: ReportBoardInput = input) {
  const { result } = renderHook(() => useReportBoard(), { wrapper });
  return act(async () => {
    await result.current.mutateAsync(variables).catch(() => undefined);
  });
}

function expectOldPreviewRetirement(generation: number, retired: boolean) {
  expect(getGymRankingRetirementGeneration() - generation).toBe(retired ? 1 : 0);
  expect(queryClient.getQueryData(rankingsKey)).toEqual(retired ? undefined : rankingsReceipt);
  expect(queryClient.getQueryData(overviewKey)).toEqual(overviewReceipt);
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClient.setQueryData(rankingsKey, rankingsReceipt);
  queryClient.setQueryData(overviewKey, overviewReceipt);
  request.mockReset();
  confirm.mockReset().mockResolvedValue(true);
  applyChangedBoard.mockReset().mockResolvedValue(undefined);
});

describe('native setup changes retire copied Rankings previews', () => {
  it('retires after an applied suggestion with no board in the response', async () => {
    const generation = getGymRankingRetirementGeneration();
    request.mockResolvedValue(submitted('APPLIED'));
    await report();
    expect(request).toHaveBeenCalledWith(REPORT_BOARD, { input });
    expectOldPreviewRetirement(generation, true);
  });

  it('retires after the exact setup unchanged refusal', async () => {
    const generation = getGymRankingRetirementGeneration();
    request.mockRejectedValue(refusal('BAD_USER_INPUT', 'SETUP_UNCHANGED'));
    await report();
    expectOldPreviewRetirement(generation, true);
  });

  it('retires after a successful undo', async () => {
    const generation = getGymRankingRetirementGeneration();
    request.mockResolvedValue({ undoBoardSetupChange: restored });
    const { result } = renderHook(() => useUndoSetupChange(), { wrapper });
    await act(async () => {
      await expect(result.current(notification)).resolves.toBe('undone');
    });
    expect(request).toHaveBeenCalledWith(UNDO_BOARD_SETUP_CHANGE, { eventId: '42' });
    expect(applyChangedBoard).toHaveBeenCalledWith(restored);
    expectOldPreviewRetirement(generation, true);
  });

  it('retires after an already undone refusal even when the board read fails', async () => {
    const generation = getGymRankingRetirementGeneration();
    request.mockRejectedValueOnce(refusal('BOARD_SETUP_ALREADY_UNDONE')).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useUndoSetupChange(), { wrapper });
    await act(async () => {
      await expect(result.current(notification)).resolves.toBe('already_undone');
    });
    expect(request).toHaveBeenNthCalledWith(2, GET_BOARD, { boardUuid });
    expect(applyChangedBoard).not.toHaveBeenCalled();
    expectOldPreviewRetirement(generation, true);
  });

  it.each([
    ['sent for review', () => request.mockResolvedValue(submitted('SENT_FOR_REVIEW')), input],
    [
      'a report without a setup',
      () => request.mockResolvedValue(submitted(null)),
      { boardUuid, reason: 'wrong_setup' },
    ],
    ['a generic rejection', () => request.mockRejectedValue(refusal('BAD_USER_INPUT')), input],
    ['an unrelated reason code', () => request.mockRejectedValue(refusal('NOT_FOUND', 'SETUP_UNCHANGED')), input],
  ] as const)('preserves the preview after %s', async (_case, settle, variables) => {
    const generation = getGymRankingRetirementGeneration();
    settle();
    await report(variables);
    expectOldPreviewRetirement(generation, false);
  });

  it.each([
    ['BOARD_SETUP_CHANGED_SINCE', 'changed_since'],
    ['NOT_FOUND', 'not_allowed'],
  ] as const)('preserves the preview on %s undo', async (code, outcome) => {
    const generation = getGymRankingRetirementGeneration();
    request.mockRejectedValue(refusal(code));
    const { result } = renderHook(() => useUndoSetupChange(), { wrapper });
    await act(async () => {
      await expect(result.current(notification)).resolves.toBe(outcome);
    });
    expect(applyChangedBoard).not.toHaveBeenCalled();
    expectOldPreviewRetirement(generation, false);
  });

  it('preserves the preview when undo is canceled', async () => {
    const generation = getGymRankingRetirementGeneration();
    confirm.mockResolvedValue(false);
    const { result } = renderHook(() => useUndoSetupChange(), { wrapper });
    await act(async () => {
      await expect(result.current(notification)).resolves.toBe('cancelled');
    });
    expect(request).not.toHaveBeenCalled();
    expectOldPreviewRetirement(generation, false);
  });
});
