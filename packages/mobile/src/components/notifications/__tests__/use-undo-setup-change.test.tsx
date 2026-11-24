// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { DirectoryNotice, GroupedNotification, UserBoard } from '@boardsesh/shared-schema';

const confirm = vi.hoisted(() => vi.fn());
const undo = vi.hoisted(() => vi.fn());
const applyChangedBoard = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => confirm }));
vi.mock('../../../lib/graphql/hooks/use-directory-reports', () => ({ useUndoBoardSetupChange: () => undo }));
vi.mock('../../../lib/boards/use-apply-changed-board', () => ({ useApplyChangedBoard: () => applyChangedBoard }));

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

beforeEach(() => {
  confirm.mockReset();
  undo.mockReset();
  applyChangedBoard.mockReset();
  applyChangedBoard.mockResolvedValue(undefined);
});

describe('useUndoSetupChange', () => {
  it('asks first, then puts the old setup back and writes the restored board', async () => {
    confirm.mockResolvedValue(true);
    undo.mockResolvedValue(restored);
    const notification = row();
    const { result } = renderHook(() => useUndoSetupChange());
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
    const { result } = renderHook(() => useUndoSetupChange());
    await expect(result.current(row())).resolves.toBe('cancelled');
    expect(undo).not.toHaveBeenCalled();
  });

  it('answers changed_since when the board changed again', async () => {
    confirm.mockResolvedValue(true);
    undo.mockRejectedValue({ response: { errors: [{ extensions: { code: 'BOARD_SETUP_CHANGED_SINCE' } }] } });
    const { result } = renderHook(() => useUndoSetupChange());
    await expect(result.current(row())).resolves.toBe('changed_since');
    expect(applyChangedBoard).not.toHaveBeenCalled();
  });

  it('throws any other failure for the row to show', async () => {
    confirm.mockResolvedValue(true);
    undo.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useUndoSetupChange());
    await expect(result.current(row())).rejects.toThrow('offline');
  });

  it('still counts as undone when the stored active board fails to take it', async () => {
    confirm.mockResolvedValue(true);
    undo.mockResolvedValue(restored);
    applyChangedBoard.mockRejectedValue(new Error('disk full'));
    const { result } = renderHook(() => useUndoSetupChange());
    await expect(result.current(row())).resolves.toBe('undone');
  });

  it('asks nothing for a change that is no longer live', async () => {
    const { result } = renderHook(() => useUndoSetupChange());
    await expect(result.current(row({ setupChangeState: 'UNDONE' }))).resolves.toBe('cancelled');
    expect(confirm).not.toHaveBeenCalled();
  });
});
