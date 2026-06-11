// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const crypto = vi.hoisted(() => {
  let index = 0;
  const randomUUID = vi.fn(() => `preview-${++index}`);
  return {
    randomUUID,
    reset: () => {
      index = 0;
      randomUUID.mockClear();
    },
  };
});

const boardProvider = vi.hoisted(() => ({
  isAuthenticated: true,
  saveClimb: vi.fn(),
  updateClimb: vi.fn(),
}));
const queue = vi.hoisted(() => ({ setCurrentClimb: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const editClimb = vi.hoisted(() => ({ data: undefined as unknown }));

const createClimb = vi.hoisted(() => ({
  litUpHoldsMap: { 1: { state: 'STARTING' }, 2: { state: 'HAND' }, 3: { state: 'FINISH' } },
  setHoldState: vi.fn(),
  generateFramesString: vi.fn(() => 'p1r12p2r13p3r14'),
  startingCount: 1,
  finishCount: 1,
  isValid: true,
  resetHolds: vi.fn(),
  loadHolds: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  canUndo: false,
  canRedo: false,
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: crypto.randomUUID }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@boardsesh/shared-schema', () => ({
  isNoMatchClimb: () => false,
  withNoMatch: (description: string | null | undefined) => description ?? '',
}));
vi.mock('@boardsesh/create-climb-react', () => ({
  useCreateClimb: () => createClimb,
  computeCanUpdate: (savedClimb: unknown) => savedClimb != null,
  computeEditLocked: () => false,
  buildInitialHoldsMap: () => ({}),
}));
vi.mock('@boardsesh/board-react', () => ({
  useBoardProvider: () => ({
    isAuthenticated: boardProvider.isAuthenticated,
    saveClimb: boardProvider.saveClimb,
    updateClimb: boardProvider.updateClimb,
  }),
  isDuplicateClimbError: () => false,
}));
vi.mock('@boardsesh/graphql-client', () => ({
  GraphQLOperationError: class GraphQLOperationError extends Error {},
}));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ refreshAuthState: vi.fn() }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { displayName: 'Tester' } }),
  useClimb: () => ({ data: editClimb.data }),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ setCurrentClimb: queue.setCurrentClimb }),
}));
vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => null,
}));
vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../../../lib/climb-to-queue-item', () => ({
  climbToQueueItem: (climb: { uuid: string; angle: number }, options: { uuid: string }) => ({ climb, options }),
}));
vi.mock('../../../lib/create-climb-draft-store', () => ({
  loadDraft: vi.fn(async () => null),
  saveDraft: vi.fn(async () => {}),
  clearDraft: vi.fn(async () => {}),
  createClimbDraftKey: (board: { angle: number }) => `draft-${board.angle}`,
}));
vi.mock('../brush-roles', () => ({
  getPaintRoles: () => ['HAND', 'STARTING', 'FINISH'],
}));

import { useCreateClimbScreen, type CreateClimbBoard } from '../use-create-climb-screen';
import { deriveSaveButtonView } from '../save-button-view';

const BOARD_25: CreateClimbBoard = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 25,
};
const BOARD_40: CreateClimbBoard = { ...BOARD_25, angle: 40 };

type QueuePayload = {
  climb: { uuid: string; angle: number };
  options: { uuid: string };
};

beforeEach(() => {
  crypto.reset();
  boardProvider.isAuthenticated = true;
  boardProvider.saveClimb.mockReset();
  boardProvider.updateClimb.mockReset();
  queue.setCurrentClimb.mockClear();
  router.push.mockClear();
  editClimb.data = undefined;
  createClimb.setHoldState.mockClear();
  createClimb.generateFramesString.mockClear();
  createClimb.resetHolds.mockClear();
  createClimb.loadHolds.mockClear();
  createClimb.undo.mockClear();
  createClimb.redo.mockClear();
});

describe('useCreateClimbScreen angle changes', () => {
  it('drops the saved climb identity and uses a fresh queue uuid after a new-climb angle change', async () => {
    boardProvider.saveClimb.mockResolvedValueOnce({
      uuid: 'saved-at-25',
      createdAt: null,
      publishedAt: null,
      isDraft: true,
    });
    boardProvider.saveClimb.mockResolvedValueOnce({
      uuid: 'saved-at-40',
      createdAt: null,
      publishedAt: null,
      isDraft: true,
    });

    const { result, rerender } = renderHook(
      ({ board }: { board: CreateClimbBoard }) => useCreateClimbScreen({ board }),
      { initialProps: { board: BOARD_25 } },
    );

    act(() => result.current.setName('Angle-sensitive draft'));
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardProvider.saveClimb).toHaveBeenCalledWith(expect.objectContaining({ angle: 25 }));
    queue.setCurrentClimb.mockClear();
    createClimb.resetHolds.mockClear();
    createClimb.loadHolds.mockClear();

    rerender({ board: BOARD_40 });
    await act(async () => {});

    expect(result.current.litUpHoldsMap).toBe(createClimb.litUpHoldsMap);
    expect(result.current.name).toBe('Angle-sensitive draft');
    expect(createClimb.resetHolds).not.toHaveBeenCalled();
    expect(createClimb.loadHolds).not.toHaveBeenCalled();

    act(() => result.current.handleSetActive());

    const payload = queue.setCurrentClimb.mock.calls[0]?.[0] as QueuePayload | undefined;
    expect(payload?.options.uuid).toBe('preview-2');
    expect(payload?.climb.uuid).toBe('preview-2');
    expect(payload?.climb.angle).toBe(40);

    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardProvider.saveClimb).toHaveBeenCalledTimes(2);
    expect(boardProvider.saveClimb).toHaveBeenLastCalledWith(expect.objectContaining({ angle: 40 }));
    expect(boardProvider.updateClimb).not.toHaveBeenCalled();
  });

  it('keeps the loaded saved climb in edit mode when the board angle changes', async () => {
    editClimb.data = {
      uuid: 'existing-climb',
      name: 'Existing climb',
      description: '',
      frames: 'p1r12',
      is_draft: false,
      created_at: '2026-01-01T00:00:00.000Z',
      published_at: '2026-01-02T00:00:00.000Z',
    };
    boardProvider.updateClimb.mockResolvedValue({
      uuid: 'existing-climb',
      createdAt: '2026-01-01T00:00:00.000Z',
      publishedAt: '2026-01-02T00:00:00.000Z',
      isDraft: false,
    });

    const { result, rerender } = renderHook(
      ({ board }: { board: CreateClimbBoard }) => useCreateClimbScreen({ board, editClimbUuid: 'existing-climb' }),
      { initialProps: { board: BOARD_25 } },
    );

    await waitFor(() => expect(result.current.name).toBe('Existing climb'));
    act(() => result.current.setName('Edited at new angle'));

    rerender({ board: BOARD_40 });
    await act(async () => {});
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardProvider.updateClimb).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'existing-climb', angle: 40 }),
    );
    expect(boardProvider.saveClimb).not.toHaveBeenCalled();
  });

  it('does not create a new climb if edit save is tapped before the existing climb loads', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD_25, editClimbUuid: 'existing-climb' }));

    act(() => result.current.setName('Premature edit save'));
    expect(deriveSaveButtonView(result.current.saveState, (key) => key).disabled).toBe(true);

    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardProvider.saveClimb).not.toHaveBeenCalled();
    expect(boardProvider.updateClimb).not.toHaveBeenCalled();
  });
});
