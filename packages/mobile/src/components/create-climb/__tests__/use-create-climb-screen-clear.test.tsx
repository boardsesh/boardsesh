// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drives the create-climb controller through Clear, then a fresh Save, asserting
// the leftover "No match" toggle does not leak into the next brand-new climb.
// Uses a real-ish `withNoMatch` (prefixes when enabled) so the description sent
// to `saveClimb` reflects whether `noMatch` was reset.

const board = vi.hoisted(() => ({
  isAuthenticated: true,
  saveClimb: vi.fn(),
  updateClimb: vi.fn(),
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const queue = vi.hoisted(() => ({ setCurrentClimb: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const draftStore = vi.hoisted(() => ({
  loadDraft: vi.fn(async () => null),
  saveDraft: vi.fn(async (_key: string, _draft: Record<string, unknown>) => {}),
  clearDraft: vi.fn(async (_key: string) => {}),
}));

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

// Real-ish no-match encoding: enabling prepends the canonical marker so the
// leaked-toggle bug is observable in the description sent to saveClimb.
const NO_MATCH_PREFIX = 'No match\n';
vi.mock('@boardsesh/shared-schema', () => ({
  isNoMatchClimb: (description: string | null | undefined) => /^no match/i.test(description ?? ''),
  withNoMatch: (description: string | null | undefined, enabled: boolean) => {
    const current = description ?? '';
    if (enabled) return /^no match/i.test(current) ? current : `${NO_MATCH_PREFIX}${current}`;
    return current.replace(/^no match(?:\r?\n|$)/i, '');
  },
  CLIMB_CHARACTERISTICS: { NO_KICKBOARD: 'no_kickboard', CAMPUS: 'campus', NO_MATCH: 'no_match' },
  hasCharacteristic: (characteristics: string[] | null | undefined, token: string) =>
    !!characteristics && characteristics.includes(token),
  isNoKickboard: (characteristics: string[] | null | undefined) =>
    !!characteristics && characteristics.includes('no_kickboard'),
  isCampus: (characteristics: string[] | null | undefined) => !!characteristics && characteristics.includes('campus'),
  withCharacteristic: (characteristics: string[] | null | undefined, token: string, enabled: boolean) => {
    const current = characteristics ? [...characteristics] : [];
    if (!enabled) return current.filter((existing) => existing !== token);
    return current.includes(token) ? current : [...current, token];
  },
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
  loadDraft: draftStore.loadDraft,
  saveDraft: draftStore.saveDraft,
  clearDraft: draftStore.clearDraft,
  createClimbDraftKey: () => 'draft-key',
  createClimbEditDraftKey: (boardType: string, uuid: string) => `edit:${boardType}:${uuid}`,
  createClimbForkDraftKey: (boardKey: string) => `fork:${boardKey}`,
  isDraftStorageAvailable: () => true,
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

beforeEach(() => {
  board.saveClimb.mockReset();
  board.updateClimb.mockReset();
  toast.showToast.mockClear();
  queue.setCurrentClimb.mockClear();
  draftStore.clearDraft.mockClear();
  draftStore.saveDraft.mockClear();
  createClimb.resetHolds.mockClear();
});

describe('useCreateClimbScreen handleNewClimb', () => {
  it('resets the No-match toggle so a brand-new climb is not silently tagged no-match', async () => {
    board.saveClimb.mockResolvedValue({ uuid: 'fresh', createdAt: null, publishedAt: null, isDraft: true });

    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    // The previous climb used the No-match rule.
    act(() => result.current.setNoMatch(true));
    await waitFor(() => expect(result.current.noMatch).toBe(true));

    // Start fresh. Holds are painted and nothing is saved, so this raises the
    // inline confirm first; accept it.
    act(() => result.current.handleNewClimb());
    await act(async () => {
      result.current.confirmNewClimb();
      await Promise.resolve();
    });

    // A brand-new climb must start without any rule markers.
    expect(result.current.noMatch).toBe(false);

    // And a Save immediately after Clear must not encode "No match\n".
    act(() => result.current.setName('Fresh Problem'));
    await act(async () => {
      await result.current.handleSave();
    });

    expect(board.saveClimb).toHaveBeenCalledTimes(1);
    const savedDescription = board.saveClimb.mock.calls[0]?.[0]?.description ?? '';
    expect(savedDescription.startsWith('No match')).toBe(false);
  });

  it('resets the no-kickboard / campus toggles so a brand-new climb starts without either', async () => {
    board.saveClimb.mockResolvedValue({ uuid: 'fresh-2', createdAt: null, publishedAt: null, isDraft: true });

    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => {
      result.current.setNoKickboard(true);
      result.current.setCampus(true);
    });
    await waitFor(() => expect(result.current.noKickboard).toBe(true));
    expect(result.current.campus).toBe(true);

    await act(async () => {
      await result.current.handleNewClimb();
    });

    expect(result.current.noKickboard).toBe(false);
    expect(result.current.campus).toBe(false);

    act(() => result.current.setName('Fresh Problem 2'));
    await act(async () => {
      await result.current.handleSave();
    });

    expect(board.saveClimb).toHaveBeenCalledTimes(1);
    expect(board.saveClimb.mock.calls[0]?.[0]?.characteristics).toBeNull();
  });

  it('clears only the holds when Clear holds is tapped', async () => {
    // The trash button used to also wipe the name, the description, the saved-row
    // link and the on-device slot — none of which undo brings back — behind a
    // label that said "Clear holds". Now the label is the whole behaviour.
    board.saveClimb.mockResolvedValue({ uuid: 'row-1', createdAt: null, publishedAt: null, isDraft: true });
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    act(() => {
      result.current.setName('Keep my name');
      result.current.setDescription('keep my beta');
    });
    await act(async () => {
      await result.current.handleSave();
    });
    draftStore.clearDraft.mockClear();

    act(() => result.current.handleClearHolds());

    expect(createClimb.resetHolds).toHaveBeenCalledTimes(1);
    expect(result.current.name).toBe('Keep my name');
    expect(result.current.description).toBe('keep my beta');
    expect(draftStore.clearDraft).not.toHaveBeenCalled();
  });

  it('starts a new climb without prompting once the work is in your drafts', async () => {
    board.saveClimb.mockResolvedValue({ uuid: 'row-1', createdAt: null, publishedAt: null, isDraft: true });
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    act(() => result.current.setName('Already saved'));
    await act(async () => {
      await result.current.handleSave();
    });
    draftStore.clearDraft.mockClear();

    await act(async () => {
      result.current.handleNewClimb();
      await Promise.resolve();
    });

    // Nothing is at risk: the row is in Open drafts. Only the new-climb slot goes,
    // never an `edit:` slot.
    expect(result.current.pendingNewClimb).toBe(false);
    expect(draftStore.clearDraft).toHaveBeenCalledWith('draft-key');
    expect(result.current.name).toBe('');
  });

  it('asks before dropping edits made after the last draft save', async () => {
    board.saveClimb.mockResolvedValue({ uuid: 'row-1', createdAt: null, publishedAt: null, isDraft: true });
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    act(() => result.current.setName('Saved first'));
    await act(async () => {
      await result.current.handleSave();
    });

    act(() => result.current.setDescription('phone-only beta'));
    act(() => result.current.handleNewClimb());

    expect(result.current.pendingNewClimb).toBe(true);
    expect(result.current.name).toBe('Saved first');
    expect(result.current.description).toBe('phone-only beta');
  });

  it('dismisses a pending Start new confirmation after the climb is saved', async () => {
    board.saveClimb.mockResolvedValue({ uuid: 'row-1', createdAt: null, publishedAt: null, isDraft: true });
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    act(() => result.current.setName('Save while asking'));
    act(() => result.current.handleNewClimb());
    expect(result.current.pendingNewClimb).toBe(true);

    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.pendingNewClimb).toBe(false);
    expect(result.current.name).toBe('Save while asking');
  });

  it('asks inline before dropping unsaved work, and cancelling changes nothing', async () => {
    // The ask is sheet CONTENT, not a dialog. `useConfirm` renders a Paper Dialog
    // in a JS Portal on Android, which paints behind this native sheet — its
    // promise never resolves, so this button did nothing at all.
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    act(() => result.current.setName('Never saved'));
    draftStore.clearDraft.mockClear();
    createClimb.resetHolds.mockClear();

    act(() => result.current.handleNewClimb());

    expect(result.current.pendingNewClimb).toBe(true);
    expect(result.current.name).toBe('Never saved');
    expect(createClimb.resetHolds).not.toHaveBeenCalled();

    act(() => result.current.cancelNewClimb());
    expect(result.current.pendingNewClimb).toBe(false);
    expect(result.current.name).toBe('Never saved');
    expect(createClimb.resetHolds).not.toHaveBeenCalled();
    expect(draftStore.clearDraft).not.toHaveBeenCalled();
  });

  it('resets once the inline confirm is accepted', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    act(() => result.current.setName('Never saved'));
    draftStore.clearDraft.mockClear();
    createClimb.resetHolds.mockClear();

    act(() => result.current.handleNewClimb());
    await act(async () => {
      result.current.confirmNewClimb();
      await Promise.resolve();
    });

    expect(result.current.pendingNewClimb).toBe(false);
    expect(result.current.name).toBe('');
    expect(createClimb.resetHolds).toHaveBeenCalledTimes(1);
    expect(draftStore.clearDraft).toHaveBeenCalledWith('draft-key');
  });

  it('waits for the slot to be retired before resetting the editor', async () => {
    let finishClear: (() => void) | undefined;
    draftStore.clearDraft.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        }),
    );
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    act(() => result.current.setName('Keep until durable clear'));

    act(() => result.current.handleNewClimb());
    act(() => result.current.confirmNewClimb());

    expect(result.current.name).toBe('Keep until durable clear');
    expect(createClimb.resetHolds).not.toHaveBeenCalled();

    await act(async () => {
      finishClear?.();
      await Promise.resolve();
    });

    expect(result.current.name).toBe('');
    expect(createClimb.resetHolds).toHaveBeenCalledTimes(1);
  });

  it('ignores Start new confirmation while Save is in flight', async () => {
    let finishSave: ((saved: { uuid: string; createdAt: null; publishedAt: null; isDraft: true }) => void) | undefined;
    board.saveClimb.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    act(() => result.current.setName('Saving now'));
    act(() => result.current.handleNewClimb());
    expect(result.current.pendingNewClimb).toBe(true);

    let pendingSave: Promise<void> | undefined;
    act(() => {
      pendingSave = result.current.handleSave();
    });
    act(() => result.current.confirmNewClimb());

    expect(draftStore.clearDraft).not.toHaveBeenCalled();
    expect(result.current.name).toBe('Saving now');

    await act(async () => {
      finishSave?.({ uuid: 'row-1', createdAt: null, publishedAt: null, isDraft: true });
      await pendingSave;
    });

    expect(result.current.pendingNewClimb).toBe(false);
    expect(result.current.name).toBe('Saving now');
  });
});
