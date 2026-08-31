// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drives handlePaint through the real getNextBrushRole/getPaintRoles/computeRoleCapacity
// (brush-roles is intentionally left unmocked here) to pin the tap-to-cycle
// contract end to end: a first tap sets a hold straight to the selected brush;
// only a repeat tap on the same hold under the same brush — or a brush whose
// role has no room left — cycles it onward, and the eraser brush always clears.

const board = vi.hoisted(() => ({
  isAuthenticated: true,
  saveClimb: vi.fn(),
  updateClimb: vi.fn(),
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const queue = vi.hoisted(() => ({ setCurrentClimb: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn() }));

const DEFAULT_HOLDS = { 1: { state: 'STARTING' }, 2: { state: 'HAND' }, 3: { state: 'FINISH' } };

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
  createClimb.litUpHoldsMap = DEFAULT_HOLDS;
  createClimb.currentFrameIndex = 0;
  createClimb.frameCount = 1;
});

describe('useCreateClimbScreen handlePaint (tap-to-cycle)', () => {
  it('assigns the selected brush to a blank hold', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => result.current.handlePaint(4));

    expect(createClimb.setHoldState).toHaveBeenCalledWith(4, 'HAND');
  });

  it('sets a pre-painted hold straight to a newly selected brush, without cycling', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    // Hold 1 is fixture-seeded as STARTING; the default brush is HAND. The
    // very first tap under this brush just reassigns the hold — it isn't the
    // "last tapped hold under this brush" yet, and HAND is never full.
    act(() => result.current.handlePaint(1));

    expect(createClimb.setHoldState).toHaveBeenLastCalledWith(1, 'HAND');
  });

  it('cycles onward on a repeat tap of the same hold under the same brush', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => result.current.handlePaint(1));
    act(() => result.current.handlePaint(1));

    // The mock setHoldState never mutates the fixture, so hold 1 still reads
    // back as STARTING; a second tap under the same (still-selected) HAND
    // brush recognises the repeat and cycles from there instead of
    // re-confirming HAND — HAND -> FINISH -> FOOT -> STARTING -> OFF.
    expect(createClimb.setHoldState).toHaveBeenLastCalledWith(1, 'OFF');
  });

  it('sets directly again after switching brushes, even on a hold mid-cycle', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => result.current.handlePaint(1));
    act(() => result.current.setSelectedBrush('FOOT'));
    // Switching brushes breaks the "last tapped under this brush" chain, so
    // this tap reassigns hold 1 straight to FOOT instead of resuming a cycle.
    act(() => result.current.handlePaint(1));

    expect(createClimb.setHoldState).toHaveBeenLastCalledWith(1, 'FOOT');
  });

  it('cycles on the very first tap when the selected brush is already at capacity', () => {
    createClimb.litUpHoldsMap = { 1: { state: 'STARTING' }, 2: { state: 'STARTING' }, 3: { state: 'HAND' } };
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => result.current.setSelectedBrush('STARTING'));
    // Two starts are already placed, so setting hold 3 to a third start would
    // silently no-op — cycle it onward instead.
    act(() => result.current.handlePaint(3));

    expect(createClimb.setHoldState).toHaveBeenLastCalledWith(3, 'FINISH');
  });

  it('skips FOOT while campus is enabled, landing on the next open role', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => result.current.setCampus(true));
    act(() => result.current.setSelectedBrush('FOOT'));
    // Hold 4 is blank; a campus climb allows no feet, so the forced cycle
    // skips FOOT and lands on the next role in rotation, STARTING.
    act(() => result.current.handlePaint(4));

    expect(createClimb.setHoldState).toHaveBeenLastCalledWith(4, 'STARTING');
  });

  it('always erases when the eraser brush is selected', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => result.current.setSelectedBrush('OFF'));
    // Hold 2 is fixture-seeded as HAND; the eraser brush never cycles.
    act(() => result.current.handlePaint(2));

    expect(createClimb.setHoldState).toHaveBeenLastCalledWith(2, 'OFF');
  });

  it('a same-role first tap is a visible no-op, but the very next tap still cycles', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    // Hold 2 is already HAND, and the default brush is HAND too — the first
    // tap re-confirms the same role (a no-op paint), but it still counts as
    // "the last tapped hold under this brush" for the tap that follows.
    act(() => result.current.handlePaint(2));
    expect(createClimb.setHoldState).toHaveBeenLastCalledWith(2, 'HAND');

    act(() => result.current.handlePaint(2));
    expect(createClimb.setHoldState).toHaveBeenLastCalledWith(2, 'FINISH');
  });

  it('handleAssignRole resets the cycle, so a follow-up tap sets directly', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => result.current.handlePaint(1));
    // The long-press role sheet is a direct assignment, not a tap.
    act(() => result.current.handleAssignRole(1, 'FINISH'));
    // Without the reset this would resume the HAND cycle instead of setting
    // hold 1 straight to HAND again.
    act(() => result.current.handlePaint(1));

    expect(createClimb.setHoldState).toHaveBeenLastCalledWith(1, 'HAND');
  });

  it('handleClearHolds resets the cycle, so a follow-up tap sets directly', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => result.current.handlePaint(1));
    act(() => result.current.handleClearHolds());
    act(() => result.current.handlePaint(1));

    expect(createClimb.setHoldState).toHaveBeenLastCalledWith(1, 'HAND');
  });

  it('resets the cycle when the active frame changes', () => {
    const { result, rerender } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => result.current.handlePaint(1));
    createClimb.currentFrameIndex = 1;
    rerender();
    act(() => result.current.handlePaint(1));

    expect(createClimb.setHoldState).toHaveBeenLastCalledWith(1, 'HAND');
  });
});
