// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drives handlePaint through the real getNextBrushRole/getPaintRoles (brush-roles
// is intentionally left unmocked here) to pin the tap-to-cycle contract end to
// end: a tap on a hold advances it through the board's paint roles starting at
// the selected brush, while the eraser brush always clears.

const board = vi.hoisted(() => ({
  isAuthenticated: true,
  saveClimb: vi.fn(),
  updateClimb: vi.fn(),
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const queue = vi.hoisted(() => ({ setCurrentClimb: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn() }));

const createClimb = vi.hoisted(() => ({
  litUpHoldsMap: { 1: { state: 'STARTING' }, 2: { state: 'HAND' }, 3: { state: 'FINISH' } },
  frames: [{ 1: { state: 'STARTING' }, 2: { state: 'HAND' }, 3: { state: 'FINISH' } }],
  frameCount: 1,
  currentFrameIndex: 0,
  setHoldState: vi.fn(),
  generateFramesString: vi.fn(() => 'p1r12p2r13p3r14'),
  currentFrameBleString: vi.fn(() => 'p1r12p2r13p3r14'),
  startingCount: 1,
  finishCount: 1,
  isValid: true,
  resetHolds: vi.fn(),
  loadHolds: vi.fn(),
  loadFrames: vi.fn(),
  duplicateFrame: vi.fn(),
  deleteFrame: vi.fn(),
  goToFrame: vi.fn(),
  nextFrame: vi.fn(),
  prevFrame: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  canUndo: false,
  canRedo: false,
}));

// The controller only touches `AppState` from react-native (autosave flush);
// stub it so the test transformer doesn't load the real RN.
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'preview-uuid' }));
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
  buildInitialFrames: () => [{}],
}));

vi.mock('@boardsesh/board-react', () => ({
  useBoardActions: () => ({
    isAuthenticated: board.isAuthenticated,
    saveClimb: board.saveClimb,
    updateClimb: board.updateClimb,
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
  useClimb: () => ({ data: undefined }),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ setCurrentClimb: queue.setCurrentClimb }),
}));
vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => null,
}));
vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: toast.showToast }),
}));
vi.mock('../../../lib/climb-to-queue-item', () => ({ climbToQueueItem: () => ({}) }));
vi.mock('../../../lib/create-climb-draft-store', () => ({
  loadDraft: vi.fn(async () => null),
  saveDraft: vi.fn(async () => {}),
  clearDraft: vi.fn(async () => {}),
  createClimbDraftKey: () => 'draft-key',
  createClimbEditDraftKey: (boardType: string, uuid: string) => `edit:${boardType}:${uuid}`,
  createClimbForkDraftKey: (boardKey: string) => `fork:${boardKey}`,
  isDraftStorageAvailable: () => true,
}));

import { useCreateClimbScreen } from '../use-create-climb-screen';

const BOARD = {
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
};

beforeEach(() => {
  createClimb.setHoldState.mockClear();
});

describe('useCreateClimbScreen handlePaint (tap-to-cycle)', () => {
  it('assigns the selected brush to a blank hold', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => result.current.handlePaint(4));

    expect(createClimb.setHoldState).toHaveBeenCalledWith(4, 'HAND');
  });

  it('cycles a painted hold to the next role after the selected brush', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    // Hold 1 is fixture-seeded as STARTING; the default brush is HAND, so the
    // cycle order is HAND -> FINISH -> FOOT -> STARTING -> OFF.
    act(() => result.current.handlePaint(1));

    expect(createClimb.setHoldState).toHaveBeenCalledWith(1, 'OFF');
  });

  it('restarts the cycle at the newly selected brush', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => result.current.setSelectedBrush('FINISH'));
    // Hold 3 is fixture-seeded as FINISH, which is now the cycle's start, so
    // the next tap advances past it to FOOT.
    act(() => result.current.handlePaint(3));

    expect(createClimb.setHoldState).toHaveBeenCalledWith(3, 'FOOT');
  });

  it('always erases when the eraser brush is selected', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => result.current.setSelectedBrush('OFF'));
    // Hold 2 is fixture-seeded as HAND; the eraser brush never cycles.
    act(() => result.current.handlePaint(2));

    expect(createClimb.setHoldState).toHaveBeenCalledWith(2, 'OFF');
  });
});
