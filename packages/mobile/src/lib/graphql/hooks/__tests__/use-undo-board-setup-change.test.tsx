// @vitest-environment jsdom
//
// Undo on a climber's setup change moves the notice's row in the loaded inbox,
// so its line is right without reloading the feed: `UNDONE` after an undo or
// when someone undid it first (and the board is read again, its old setup is
// back), `CHANGED_SINCE` once the board changed again. A refusal that says the
// viewer may no longer undo it (`NOT_FOUND`) leaves the row's state alone.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DirectoryNotice, GroupedNotification, UserBoard } from '@boardsesh/shared-schema';
import { findCachedNotification, GROUPED_NOTIFICATIONS_QUERY_KEY } from '../../notification-read-cache';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));

import { useUndoBoardSetupChange } from '../use-directory-reports';

const notice: DirectoryNotice = {
  targetKind: 'board',
  boardUuid: 'board-1',
  boardName: 'Crux Kilter',
  boardType: 'kilter',
  isReminder: false,
  recipientIsCreator: false,
  setupChangeEventId: '42',
  setupChangeState: 'LIVE',
};
const notification = {
  uuid: 'n1',
  type: 'board_setup_changed_by_climber',
  isRead: false,
  createdAt: '2026-11-24T10:00:00.000Z',
  directoryNotice: notice,
} as unknown as GroupedNotification;

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}
const refusal = (code: string) => ({ response: { errors: [{ message: code, extensions: { code } }] } });
const stateNow = () => findCachedNotification(queryClient, 'n1')?.directoryNotice?.setupChangeState;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClient.setQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY, {
    pages: [{ groups: [notification], totalCount: 1, unreadCount: 1, hasMore: false }],
    pageParams: [null],
  });
  requestMock.mockReset();
});

async function undo() {
  const { result } = renderHook(() => useUndoBoardSetupChange(), { wrapper });
  let outcome: unknown;
  await act(async () => {
    outcome = await result.current({ eventId: '42', notification }).catch((error: unknown) => error);
  });
  return outcome;
}

describe('useUndoBoardSetupChange', () => {
  it('moves the row to UNDONE and returns the restored board', async () => {
    const restored = { uuid: 'board-1' } as UserBoard;
    requestMock.mockResolvedValue({ undoBoardSetupChange: restored });
    await expect(undo()).resolves.toBe(restored);
    expect(stateNow()).toBe('UNDONE');
  });

  it('moves the row to UNDONE and reads the board again when someone undid it first', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    requestMock.mockRejectedValue(refusal('BOARD_SETUP_ALREADY_UNDONE'));
    await undo();
    expect(stateNow()).toBe('UNDONE');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['board', 'board-1'] });
  });

  it('moves the row to CHANGED_SINCE once the board changed again', async () => {
    requestMock.mockRejectedValue(refusal('BOARD_SETUP_CHANGED_SINCE'));
    await undo();
    expect(stateNow()).toBe('CHANGED_SINCE');
  });

  it.each(['NOT_FOUND', 'INTERNAL_SERVER_ERROR'])('leaves the row as it is on %s', async (code) => {
    requestMock.mockRejectedValue(refusal(code));
    await undo();
    expect(stateNow()).toBe('LIVE');
  });
});
