// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Hoisted mock state the test drives between cases. ---------------------
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
// A single shared invalidateQueries spy (unlike a fresh `vi.fn()` per render)
// so tests can assert on it: useQueryClient() is called once per render, and a
// per-render mock would give the closure a different identity than the one the
// test holds.
const reactQuery = vi.hoisted(() => ({ invalidateQueries: vi.fn() }));

const board = vi.hoisted(() => ({
  isAuthenticated: true,
  saveClimb: vi.fn(),
  updateClimb: vi.fn(),
  // Default: a brand-new climb (no duplicate, not an exception).
  isDuplicateClimbError: vi.fn((_err: unknown) => false),
}));

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const queue = vi.hoisted(() => ({ setCurrentClimb: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn() }));

// Edit mode seeds a savedClimb from `useClimb`; when set, the save flow takes
// the update branch (`computeCanUpdate` returns true for a non-null savedClimb).
const editClimb = vi.hoisted(() => ({ data: undefined as unknown }));

// The create-climb hold-state machine. The save flow only reads back
// `generateFramesString` (non-empty so the save proceeds), `isValid` (true so it
// doesn't early-return), and `litUpHoldsMap` (for holdCount).
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

// --- Module mocks. ---------------------------------------------------------
// The controller only touches `AppState` from react-native (to flush autosave
// on background); stub it so the test transformer doesn't load the real RN.
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'preview-uuid' }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => reactQuery,
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
  // No saved snapshot at save time → the "create" branch runs by default. The
  // update branch is exercised by seeding a savedClimb via edit mode below.
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
  // Used only for the `instanceof` narrowing in readDuplicateExtensions; a plain
  // class is enough for the test (the duplicate detail isn't asserted here).
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
// The controller awaits `confirm` from here for "start a new climb"; the real
// provider pulls in react-native's Alert/Platform, which this file doesn't stub.
vi.mock('../../../providers/dialog-provider', () => ({
  useConfirm: () => vi.fn(async () => true),
}));
vi.mock('../brush-roles', () => ({
  getPaintRoles: () => ['HAND', 'STARTING', 'FINISH'],
}));

import { useCreateClimbScreen } from '../use-create-climb-screen';

const BOARD = {
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
};

// Kilter layout id 1 resolves to this human-readable name via the shared
// `getLayoutName` helper. Web sends the same name string for `boardLayout`
// (`boardDetails.layout_name`), so the events match across platforms.
const EXPECTED_BOARD_LAYOUT = 'Kilter Board Original';

function renderScreen(editClimbUuid?: string) {
  return renderHook(() => useCreateClimbScreen({ board: BOARD, editClimbUuid }));
}

async function nameAndSave(result: { current: ReturnType<typeof useCreateClimbScreen> }) {
  // A non-empty name is required or handleSave early-returns to focus the field.
  act(() => result.current.setName('My Problem'));
  await act(async () => {
    await result.current.handleSave();
  });
}

beforeEach(() => {
  analytics.track.mockClear();
  toast.showToast.mockClear();
  queue.setCurrentClimb.mockClear();
  router.push.mockClear();
  reactQuery.invalidateQueries.mockClear();
  board.isAuthenticated = true;
  board.isDuplicateClimbError.mockReturnValue(false);
  board.saveClimb.mockReset();
  board.updateClimb.mockReset();
  editClimb.data = undefined;
});

describe('useCreateClimbScreen analytics', () => {
  it('fires "Climb Created" with web-aligned boardLayout + holdCount on a successful new save', async () => {
    board.saveClimb.mockResolvedValue({
      uuid: 'new-climb',
      createdAt: null,
      publishedAt: null,
      isDraft: true,
    });

    const { result } = renderScreen();
    await nameAndSave(result);

    expect(board.saveClimb).toHaveBeenCalledTimes(1);
    // Same schema AND values as web's `Climb Created` (create-climb-form.tsx):
    // { boardLayout: <resolved layout name>, isDraft, holdCount }.
    expect(analytics.track).toHaveBeenCalledWith('Climb Created', {
      boardLayout: EXPECTED_BOARD_LAYOUT,
      isDraft: true,
      holdCount: 3,
    });
    expect(analytics.track).not.toHaveBeenCalledWith('Climb Create Failed', expect.anything());
    // #3471: create/edit/publish share one success path with useDeleteDraftClimb's
    // key set — the Open Drafts table AND the Climbs tab's infinite list must both
    // refresh, not just the plain searchClimbs cache.
    expect(reactQuery.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['searchClimbs'] });
    expect(reactQuery.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['infiniteSearchClimbs'] });
    expect(reactQuery.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['searchClimbsCount'] });
  });

  it("seeds noKickboard/campus from an existing climb's characteristics in edit mode", async () => {
    editClimb.data = {
      uuid: 'existing-toggled-climb',
      name: 'Existing Toggled',
      description: '',
      frames: 'p1r12',
      is_draft: false,
      created_at: '2026-01-01T00:00:00.000Z',
      published_at: '2026-01-02T00:00:00.000Z',
      characteristics: ['no_kickboard', 'campus'],
    };

    const { result } = renderScreen('existing-toggled-climb');
    await waitFor(() => expect(result.current.saveState).toBe('ready'));

    expect(result.current.noKickboard).toBe(true);
    expect(result.current.campus).toBe(true);
  });

  it('fires "Climb Updated" when saving an existing climb in edit mode', async () => {
    // Seed edit mode: useClimb resolves a climb, which the hook stores as
    // savedClimb so the save flow takes the update branch.
    editClimb.data = {
      uuid: 'existing-climb',
      name: 'Existing',
      description: '',
      frames: 'p1r12',
      is_draft: false,
      created_at: '2026-01-01T00:00:00.000Z',
      published_at: '2026-01-02T00:00:00.000Z',
    };
    board.updateClimb.mockResolvedValue({
      uuid: 'existing-climb',
      createdAt: '2026-01-01T00:00:00.000Z',
      publishedAt: '2026-01-02T00:00:00.000Z',
      isDraft: false,
    });

    const { result } = renderScreen('existing-climb');
    // Let the edit-mode seeding effect run (sets savedClimb).
    await waitFor(() => expect(result.current.saveState).toBe('ready'));
    await nameAndSave(result);

    expect(board.updateClimb).toHaveBeenCalledTimes(1);
    expect(board.saveClimb).not.toHaveBeenCalled();
    // Same schema AND values as web's `Climb Updated`: { boardLayout: <name>, isDraft, holdCount }.
    expect(analytics.track).toHaveBeenCalledWith('Climb Updated', {
      boardLayout: EXPECTED_BOARD_LAYOUT,
      isDraft: false,
      holdCount: 3,
    });
    expect(reactQuery.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['searchClimbs'] });
    expect(reactQuery.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['infiniteSearchClimbs'] });
    expect(reactQuery.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['searchClimbsCount'] });
  });

  it('fires "Climb Create Failed" with error_reason "duplicate" on a duplicate rejection', async () => {
    board.isDuplicateClimbError.mockReturnValue(true);
    board.saveClimb.mockRejectedValue(new Error('duplicate'));

    const { result } = renderScreen();
    await nameAndSave(result);

    await waitFor(() =>
      // Web emits `{ boardLayout: <name> }`; mobile adds a non-grouping `error_reason`.
      expect(analytics.track).toHaveBeenCalledWith('Climb Create Failed', {
        boardLayout: EXPECTED_BOARD_LAYOUT,
        error_reason: 'duplicate',
      }),
    );
    expect(analytics.track).not.toHaveBeenCalledWith('Climb Created', expect.anything());
  });

  it('fires "Climb Create Failed" with error_reason "exception" on a generic save error', async () => {
    board.isDuplicateClimbError.mockReturnValue(false);
    board.saveClimb.mockRejectedValue(new Error('network down'));

    const { result } = renderScreen();
    await nameAndSave(result);

    await waitFor(() =>
      expect(analytics.track).toHaveBeenCalledWith('Climb Create Failed', {
        boardLayout: EXPECTED_BOARD_LAYOUT,
        error_reason: 'exception',
      }),
    );
    // The generic-error branch surfaces a fallback toast (duplicate does not).
    expect(toast.showToast).toHaveBeenCalledWith('createClimbForm.alerts.saveFailedFallback', 'error');
  });
});
