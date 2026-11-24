// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DirectoryNotice, GroupedNotification, UserBoard } from '@boardsesh/shared-schema';
import { GROUPED_NOTIFICATIONS_QUERY_KEY } from '../../../lib/graphql/notification-read-cache';

const confirm = vi.hoisted(() => vi.fn());
const undo = vi.hoisted(() => vi.fn());
const applyChangedBoard = vi.hoisted(() => vi.fn());
const fetchBoard = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => confirm }));
vi.mock('../../../lib/graphql/hooks/use-directory-reports', () => ({ useUndoBoardSetupChange: () => undo }));
vi.mock('../../../lib/boards/use-apply-changed-board', () => ({ useApplyChangedBoard: () => applyChangedBoard }));
vi.mock('../../../lib/graphql/hooks/fetch-board-by-uuid', () => ({ fetchBoardByUuid: fetchBoard }));

import { useUndoSetupChange } from '../use-undo-setup-change';

function row(overrides: Partial<DirectoryNotice> = {}): GroupedNotification {
  return {
    uuid: 'n1',
    type: 'board_setup_changed_by_climber',
    entityType: 'board',
    entityId: 'board-1',
    actorCount: 0,
    actors: [],
    isRead: false,
    createdAt: '2026-11-24T10:00:00.000Z',
    directoryNotice: {
      targetKind: 'board',
      boardUuid: 'board-1',
      boardName: 'Crux Kilter',
      boardType: 'kilter',
      isReminder: false,
      recipientIsCreator: true,
      setupChangeEventId: '42',
      setupBefore: { layoutId: 1, sizeId: 10, setIds: '1,20', angle: null },
      setupAfter: { layoutId: 8, sizeId: 17, setIds: '26,27', angle: null },
      setupChangeState: 'LIVE',
      ...overrides,
    },
  } as unknown as GroupedNotification;
}

const restored = { uuid: 'board-1', layoutId: 1, sizeId: 10, setIds: '1,20' } as UserBoard;

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}
function renderUndo() {
  return renderHook(() => useUndoSetupChange(), { wrapper });
}
/** The loaded inbox, holding these rows. */
function seedInbox(...groups: GroupedNotification[]) {
  queryClient.setQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY, {
    pages: [{ groups, totalCount: groups.length, unreadCount: 0, hasMore: false }],
    pageParams: [null],
  });
}
const refusal = (code: string) => ({ response: { errors: [{ message: code, extensions: { code } }] } });

beforeEach(() => {
  queryClient = new QueryClient();
  confirm.mockReset();
  undo.mockReset();
  applyChangedBoard.mockReset();
  applyChangedBoard.mockResolvedValue(undefined);
  fetchBoard.mockReset();
});

describe('useUndoSetupChange', () => {
  it('asks first, then puts the old setup back and writes the restored board', async () => {
    confirm.mockResolvedValue(true);
    undo.mockResolvedValue(restored);
    const notification = row();
    const { result } = renderUndo();
    await expect(result.current(notification)).resolves.toBe('undone');
    expect(confirm).toHaveBeenCalledWith({
      title: 'setupChange.undoTitle',
      message:
        'setupChange.undoBody{"board":"Crux Kilter","setup":"Original · 12×12 with kickboard · Square · Bolt Ons, Screw Ons"}',
      confirmLabel: 'setupChange.undoConfirm',
      cancelLabel: 'actions.cancel',
    });
    expect(undo).toHaveBeenCalledWith({ eventId: '42', notification });
    expect(applyChangedBoard).toHaveBeenCalledWith(restored);
  });

  it('does nothing when the climber keeps the change', async () => {
    confirm.mockResolvedValue(false);
    const { result } = renderUndo();
    await expect(result.current(row())).resolves.toBe('cancelled');
    expect(undo).not.toHaveBeenCalled();
  });

  it.each([
    ['BOARD_SETUP_CHANGED_SINCE', 'changed_since'],
    // The board moved gyms or went private, or the viewer's role ended.
    ['NOT_FOUND', 'not_allowed'],
  ])('answers %s with %s, and writes no board', async (code, outcome) => {
    confirm.mockResolvedValue(true);
    undo.mockRejectedValue(refusal(code));
    const { result } = renderUndo();
    await expect(result.current(row())).resolves.toBe(outcome);
    expect(fetchBoard).not.toHaveBeenCalled();
    expect(applyChangedBoard).not.toHaveBeenCalled();
  });

  it('reads the board again and writes it when someone put the old setup back first', async () => {
    confirm.mockResolvedValue(true);
    undo.mockRejectedValue(refusal('BOARD_SETUP_ALREADY_UNDONE'));
    fetchBoard.mockResolvedValue(restored);
    const { result } = renderUndo();
    await expect(result.current(row())).resolves.toBe('already_undone');
    expect(fetchBoard).toHaveBeenCalledWith('board-1');
    expect(applyChangedBoard).toHaveBeenCalledWith(restored);
  });

  it.each([
    ['the read fails', () => fetchBoard.mockRejectedValue(new Error('offline'))],
    ['the board is gone', () => fetchBoard.mockResolvedValue(null)],
  ])('still reads as already undone, writing no board, when %s', async (_case, arrange) => {
    confirm.mockResolvedValue(true);
    undo.mockRejectedValue(refusal('BOARD_SETUP_ALREADY_UNDONE'));
    arrange();
    const { result } = renderUndo();
    await expect(result.current(row())).resolves.toBe('already_undone');
    expect(applyChangedBoard).not.toHaveBeenCalled();
  });

  it('still reads as already undone when the stored active board fails to take the board', async () => {
    confirm.mockResolvedValue(true);
    undo.mockRejectedValue(refusal('BOARD_SETUP_ALREADY_UNDONE'));
    fetchBoard.mockResolvedValue(restored);
    applyChangedBoard.mockRejectedValue(new Error('disk full'));
    const { result } = renderUndo();
    await expect(result.current(row())).resolves.toBe('already_undone');
  });

  it('undoes nothing when the change stopped being live while the confirm was up', async () => {
    const notification = row();
    seedInbox(notification);
    confirm.mockImplementation(async () => {
      // The inbox reloaded meanwhile: another device undid it.
      seedInbox(row({ setupChangeState: 'UNDONE' }));
      return true;
    });
    const { result } = renderUndo();
    await expect(result.current(notification)).resolves.toBe('cancelled');
    expect(undo).not.toHaveBeenCalled();
  });

  it('undoes a change the loaded inbox still shows live', async () => {
    const notification = row();
    seedInbox(notification);
    confirm.mockResolvedValue(true);
    undo.mockResolvedValue(restored);
    const { result } = renderUndo();
    await expect(result.current(notification)).resolves.toBe('undone');
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('throws any other failure for the row to show', async () => {
    confirm.mockResolvedValue(true);
    undo.mockRejectedValue(new Error('offline'));
    const { result } = renderUndo();
    await expect(result.current(row())).rejects.toThrow('offline');
  });

  it('still counts as undone when the stored active board fails to take it', async () => {
    confirm.mockResolvedValue(true);
    undo.mockResolvedValue(restored);
    applyChangedBoard.mockRejectedValue(new Error('disk full'));
    const { result } = renderUndo();
    await expect(result.current(row())).resolves.toBe('undone');
  });

  it('asks nothing for a change that is no longer live', async () => {
    const { result } = renderUndo();
    await expect(result.current(row({ setupChangeState: 'UNDONE' }))).resolves.toBe('cancelled');
    expect(confirm).not.toHaveBeenCalled();
  });
});
