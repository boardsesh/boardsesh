// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Guards the working-angle change effect in useCreateClimbScreen: because the
// screen key excludes `angle`, the hook stays mounted across an angle change, so
// the effect must detach the saved-climb row + mint a fresh preview uuid so
// Set Active / Save operate on the new angle as a fresh authoring context —
// except in edit mode, where the identity is the edited climb (not the angle).

// randomUUID returns a distinct value per call so we can tell a freshly minted
// preview uuid from the stale one (and from a saved server uuid).
const cryptoMock = vi.hoisted(() => {
  let counter = 0;
  return { randomUUID: vi.fn(() => `uuid-${++counter}`) };
});

const board = vi.hoisted(() => ({
  isAuthenticated: true,
  saveClimb: vi.fn(),
  updateClimb: vi.fn(),
  isDuplicateClimbError: vi.fn((_err: unknown) => false),
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const queue = vi.hoisted(() => ({ setCurrentClimb: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
// Edit mode seeds a savedClimb from `useClimb`.
const editClimb = vi.hoisted(() => ({ data: undefined as unknown }));

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
vi.mock('expo-crypto', () => ({ randomUUID: cryptoMock.randomUUID }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
// Partial: the controller now reads @boardsesh/board-config too, which imports
// this package for real (SUPPORTED_BOARDS). A total mock breaks that import.
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
    isAuthenticated: board.isAuthenticated,
    saveClimb: board.saveClimb,
    updateClimb: board.updateClimb,
  }),
  isDuplicateClimbError: (err: unknown) => board.isDuplicateClimbError(err),
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
  useToast: () => ({ showToast: toast.showToast }),
}));
// Pass the provisional climb straight through so the test can read its uuid +
// angle off the queue item handed to setCurrentClimb.
vi.mock('../../../lib/climb-to-queue-item', () => ({
  climbToQueueItem: (climb: unknown) => climb,
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
vi.mock('../brush-roles', () => ({
  getPaintRoles: () => ['HAND', 'STARTING', 'FINISH'],
}));

import { useCreateClimbScreen } from '../use-create-climb-screen';

type ProvisionalQueueItem = { uuid: string; angle: number };

function boardAt(angle: number) {
  return { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle };
}

/** The uuid + angle of the last queue item pushed via handleSetActive. */
function lastSetActive(): ProvisionalQueueItem {
  const calls = queue.setCurrentClimb.mock.calls;
  return calls[calls.length - 1]?.[0] as ProvisionalQueueItem;
}

beforeEach(() => {
  toast.showToast.mockClear();
  queue.setCurrentClimb.mockClear();
  router.push.mockClear();
  cryptoMock.randomUUID.mockClear();
  board.isAuthenticated = true;
  board.isDuplicateClimbError.mockReturnValue(false);
  board.saveClimb.mockReset();
  board.updateClimb.mockReset();
  editClimb.data = undefined;
});

describe('useCreateClimbScreen working-angle change', () => {
  it('detaches the saved climb + mints a fresh preview uuid so Set Active tracks the new angle', async () => {
    board.saveClimb.mockResolvedValue({ uuid: 'saved-25', createdAt: null, publishedAt: null, isDraft: true });

    const { result, rerender } = renderHook(
      (props: { board: ReturnType<typeof boardAt> }) => useCreateClimbScreen(props),
      {
        initialProps: { board: boardAt(25) },
      },
    );

    // Before any save, Set Active uses the WIP preview uuid stamped at 25°.
    act(() => result.current.handleSetActive());
    const initialPreview = lastSetActive();
    expect(initialPreview.angle).toBe(25);

    // Save at 25° → Set Active now rides the saved server row.
    act(() => result.current.setName('Slab Project'));
    await act(async () => {
      await result.current.handleSave();
    });
    act(() => result.current.handleSetActive());
    expect(lastSetActive().uuid).toBe('saved-25');

    // Switch the working angle to 40°.
    rerender({ board: boardAt(40) });

    // Set Active must no longer masquerade as the 25° server climb: fresh uuid
    // (neither the saved row nor the stale pre-save preview) and the new angle.
    act(() => result.current.handleSetActive());
    const afterChange = lastSetActive();
    expect(afterChange.uuid).not.toBe('saved-25');
    expect(afterChange.uuid).not.toBe(initialPreview.uuid);
    expect(afterChange.angle).toBe(40);
    // A save after the angle change creates a NEW climb (no update of the 25° row).
    board.saveClimb.mockResolvedValue({ uuid: 'saved-40', createdAt: null, publishedAt: null, isDraft: true });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(board.saveClimb).toHaveBeenCalledTimes(2);
    expect(board.updateClimb).not.toHaveBeenCalled();
  });

  it('clears a stale duplicate banner when the angle changes', async () => {
    board.isDuplicateClimbError.mockReturnValue(true);
    board.saveClimb.mockRejectedValue(new Error('duplicate'));

    const { result, rerender } = renderHook(
      (props: { board: ReturnType<typeof boardAt> }) => useCreateClimbScreen(props),
      {
        initialProps: { board: boardAt(25) },
      },
    );

    act(() => result.current.setName('Dup Problem'));
    await act(async () => {
      await result.current.handleSave();
    });
    await waitFor(() => expect(result.current.publishDuplicateError).not.toBeNull());

    rerender({ board: boardAt(40) });

    expect(result.current.publishDuplicateError).toBeNull();
  });

  it('does NOT detach the saved climb in edit mode when the angle changes', async () => {
    editClimb.data = {
      uuid: 'edit-uuid',
      name: 'Existing',
      description: '',
      frames: 'p1r12',
      is_draft: true,
      created_at: '2026-01-01T00:00:00.000Z',
      published_at: null,
    };

    const { result, rerender } = renderHook(
      (props: { board: ReturnType<typeof boardAt>; editClimbUuid?: string }) => useCreateClimbScreen(props),
      { initialProps: { board: boardAt(25), editClimbUuid: 'edit-uuid' } },
    );

    // Wait for the edit-mode seed effect to set savedClimb.
    await waitFor(() => expect(result.current.name).toBe('Existing'));
    act(() => result.current.handleSetActive());
    expect(lastSetActive().uuid).toBe('edit-uuid');

    // Changing the angle in edit mode keeps editing the same row.
    rerender({ board: boardAt(40), editClimbUuid: 'edit-uuid' });

    act(() => result.current.handleSetActive());
    expect(lastSetActive().uuid).toBe('edit-uuid');
  });
});
