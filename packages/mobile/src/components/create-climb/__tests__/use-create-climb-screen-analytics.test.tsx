// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Hoisted mock state the test drives between cases. ---------------------
const analytics = vi.hoisted(() => ({ track: vi.fn() }));

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
// doesn't early-return), and `totalHolds` (the non-OFF hold count → holdCount,
// matching web). The 3-hold map mirrors totalHolds=3.
const createClimb = vi.hoisted(() => ({
  litUpHoldsMap: { 1: { state: 'STARTING' }, 2: { state: 'HAND' }, 3: { state: 'FINISH' } },
  setHoldState: vi.fn(),
  generateFramesString: vi.fn(() => 'p1r12p2r13p3r14'),
  startingCount: 1,
  finishCount: 1,
  totalHolds: 3,
  isValid: true,
  resetHolds: vi.fn(),
  loadHolds: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  canUndo: false,
  canRedo: false,
}));

// --- Module mocks. ---------------------------------------------------------
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'preview-uuid' }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@boardsesh/shared-schema', () => ({
  isNoMatchClimb: () => false,
  withNoMatch: (description: string) => description,
}));

vi.mock('@boardsesh/create-climb-react', () => ({
  useCreateClimb: () => createClimb,
  // No saved snapshot at save time → the "create" branch runs by default. The
  // update branch is exercised by seeding a savedClimb via edit mode below.
  computeCanUpdate: (savedClimb: unknown) => savedClimb != null,
  computeEditLocked: () => false,
  buildInitialHoldsMap: () => ({}),
}));

vi.mock('@boardsesh/board-react', () => ({
  useBoardProvider: () => ({
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
  useQueue: () => ({ setCurrentClimb: queue.setCurrentClimb }),
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
