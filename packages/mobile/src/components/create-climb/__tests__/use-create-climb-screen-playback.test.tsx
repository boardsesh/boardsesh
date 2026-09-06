// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Guards the wall hand-off contract the create drawer's route transport needs.
//
// Two writers can drive the same wall from this one sheet: the creator (which
// lights the frame you are editing) and the queue auto-sender (which lights the
// whole route once Set Active hands it over). Without a hand-off flag the wall
// shows the union while the transport still reads "2 / 3", and the next paint's
// debounced preview silently snatches it back.

const bluetooth = vi.hoisted(() => ({
  isConnected: true,
  loading: false,
  sendFramesToBoard: vi.fn(async () => true),
  invalidateWallState: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

const queue = vi.hoisted(() => ({ setCurrentClimb: vi.fn() }));
const boardActions = vi.hoisted(() => ({
  saveClimb: vi.fn(async () => ({ uuid: 'saved-1', createdAt: null, publishedAt: null, isDraft: true })),
  updateClimb: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn() }));

const frameOne = { 1: { state: 'STARTING' }, 2: { state: 'HAND' } };
const frameTwo = { 1: { state: 'STARTING' }, 2: { state: 'HAND' }, 3: { state: 'FINISH' } };

const createClimb = vi.hoisted(() => ({
  litUpHoldsMap: { 1: { state: 'STARTING' }, 2: { state: 'HAND' } },
  frames: [
    { 1: { state: 'STARTING' }, 2: { state: 'HAND' } },
    { 1: { state: 'STARTING' }, 2: { state: 'HAND' }, 3: { state: 'FINISH' } },
  ],
  frameCount: 2,
  currentFrameIndex: 0,
  setHoldState: vi.fn(),
  generateFramesString: vi.fn(() => 'p1r42p2r43,"p3r44'),
  currentFrameBleString: vi.fn(() => 'p1r42p2r43'),
  startingCount: 1,
  finishCount: 1,
  isValid: true,
  canSave: true,
  canPublish: true,
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

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-1' }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
// Partial: the controller reads the real board capabilities (getBoardCapabilities,
// which decides supportsMultiFrame) and @boardsesh/board-config imports this
// package for SUPPORTED_BOARDS. A total mock breaks both.
vi.mock('@boardsesh/shared-schema', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/shared-schema')>()),
  isNoMatchClimb: () => false,
  withNoMatch: (description: string) => description,
}));
vi.mock('@boardsesh/create-climb-react', () => ({
  useCreateClimb: () => createClimb,
  computeCanUpdate: (savedClimb: unknown) => savedClimb != null,
  computeEditLocked: () => false,
  buildInitialFrames: () => [{}],
}));
vi.mock('@boardsesh/board-react', () => ({
  useBoardActions: () => ({
    isAuthenticated: true,
    saveClimb: boardActions.saveClimb,
    updateClimb: boardActions.updateClimb,
  }),
  isDuplicateClimbError: () => false,
}));
vi.mock('@boardsesh/graphql-client', () => ({
  GraphQLOperationError: class GraphQLOperationError extends Error {},
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ refreshAuthState: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'user-1', displayName: 'Tester' } }),
  useClimb: () => ({ data: undefined }),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ setCurrentClimb: queue.setCurrentClimb }),
}));
vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => bluetooth,
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/climb-to-queue-item', () => ({
  climbToQueueItem: (climb: unknown, extra: Record<string, unknown>) => ({ ...extra, climb }),
}));
vi.mock('../../../lib/create-climb-draft-store', () => ({
  loadDraft: vi.fn(async () => null),
  saveDraft: vi.fn(async () => {}),
  clearDraft: vi.fn(async () => {}),
  createClimbDraftKey: () => 'draft-key',
  createClimbEditDraftKey: (boardType: string, uuid: string) => `edit:${boardType}:${uuid}`,
  createClimbForkDraftKey: (boardKey: string) => `fork:${boardKey}`,
  isDraftStorageAvailable: () => true,
}));
// The controller awaits `confirm` from here for "start a new climb"; the real
// provider pulls in react-native's Alert/Platform, which this file doesn't stub.
vi.mock('../../../providers/dialog-provider', () => ({
  useConfirm: () => vi.fn(async () => true),
}));
// Partial: handlePaint calls the real computeRoleCapacity, so only the board's
// role list is stubbed.
vi.mock('../brush-roles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../brush-roles')>()),
  getPaintRoles: () => ['HAND', 'STARTING', 'FINISH'],
}));

import { useCreateClimbScreen } from '../use-create-climb-screen';

const kilterBoard = { boardName: 'kilter' as const, layoutId: 8, sizeId: 17, setIds: '26,27', angle: 40 };

beforeEach(() => {
  vi.useFakeTimers();
  bluetooth.sendFramesToBoard.mockClear();
  bluetooth.invalidateWallState.mockClear();
  queue.setCurrentClimb.mockClear();
  boardActions.saveClimb.mockClear();
  createClimb.frames = [frameOne, frameTwo] as typeof createClimb.frames;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('create-climb wall hand-off', () => {
  it('starts out driving the wall itself', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));
    expect(result.current.handedOff).toBe(false);
  });

  it('hands the wall to the queue on Set Active', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.handleSetActive());

    expect(result.current.handedOff).toBe(true);
    expect(queue.setCurrentClimb).toHaveBeenCalled();
  });

  it('stops previewing the active frame while the queue owns the wall', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.handleSetActive());
    bluetooth.sendFramesToBoard.mockClear();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(bluetooth.sendFramesToBoard).not.toHaveBeenCalled();
  });

  it('takes the wall back on the next paint stroke', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));
    act(() => result.current.handleSetActive());
    expect(result.current.handedOff).toBe(true);

    act(() => result.current.handlePaint(7));

    expect(result.current.handedOff).toBe(false);
    expect(createClimb.setHoldState).toHaveBeenCalledWith(7, 'HAND');
  });

  it('takes the wall back on duplicate, delete and play', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.handleSetActive());
    act(() => result.current.duplicateFrame());
    expect(result.current.handedOff).toBe(false);
    expect(createClimb.duplicateFrame).toHaveBeenCalled();

    act(() => result.current.handleSetActive());
    act(() => result.current.deleteFrame());
    expect(result.current.handedOff).toBe(false);
    expect(createClimb.deleteFrame).toHaveBeenCalled();

    act(() => result.current.handleSetActive());
    act(() => result.current.playback.play());
    expect(result.current.handedOff).toBe(false);
  });

  it('takes the wall back on undo and redo', () => {
    // Undo changes what the wall should show as surely as a paint stroke does.
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.handleSetActive());
    expect(result.current.handedOff).toBe(true);
    act(() => result.current.undo());
    expect(result.current.handedOff).toBe(false);
    expect(createClimb.undo).toHaveBeenCalled();

    act(() => result.current.handleSetActive());
    act(() => result.current.redo());
    expect(result.current.handedOff).toBe(false);
    expect(createClimb.redo).toHaveBeenCalled();
  });

  it('hands the wall over on a draft save too — the drawer stays open there', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setName('Draft Route'));
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.saveClimb).toHaveBeenCalled();
    expect(result.current.handedOff).toBe(true);
  });

  it('pauses a running transport before handing over', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.playback.play());
    expect(result.current.playback.isPlaying).toBe(true);

    act(() => result.current.handleSetActive());
    expect(result.current.playback.isPlaying).toBe(false);
  });

  it('drops the auto-sender wall-state record whenever it writes the wall itself', () => {
    // The creator writes straight past the auto-sender, so its "what the wall
    // physically shows" record has to be invalidated or a later re-select of the
    // lit queue item is confirmed over the creator's frame.
    renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(bluetooth.sendFramesToBoard).toHaveBeenCalledWith('p1r42p2r43');
    expect(bluetooth.invalidateWallState).toHaveBeenCalled();
  });
});
