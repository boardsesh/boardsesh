// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The local-autosave durability contract. Autosave used to be switched OFF in
// three states — editing an existing draft, remixing, and everything after the
// first Save — and a draft-Save deleted the on-device slot outright, so "Save,
// then kill the app" lost the lot. Each `it` below pins one half of the fix:
// which slot a mode writes, and what a save is allowed to do to that slot.

const draftStore = vi.hoisted(() => ({
  loadDraft: vi.fn(async (_key: string) => null as null | Record<string, unknown>),
  saveDraft: vi.fn(async (_key: string, _draft: Record<string, unknown>) => {}),
  clearDraft: vi.fn(async (_key: string) => {}),
  createClimbDraftKey: vi.fn((_config: { angle: number }) => 'draft-key'),
  createClimbEditDraftKey: vi.fn((boardType: string, uuid: string) => `edit:${boardType}:${uuid}`),
  createClimbForkDraftKey: vi.fn((boardKey: string) => `fork:${boardKey}`),
  isDraftStorageAvailable: vi.fn(() => true),
}));

const appState = vi.hoisted(() => ({
  listeners: [] as Array<(state: string) => void>,
  addEventListener: vi.fn((_event: string, handler: (state: string) => void) => {
    appState.listeners.push(handler);
    return { remove: vi.fn() };
  }),
  emit(state: string) {
    appState.listeners.forEach((handler) => handler(state));
  },
}));

// `useClimb` is what edit mode seeds from, so tests that mount in edit mode have
// to drive it. Parameterised the way use-create-climb-screen-angle.test.tsx does.
const graphql = vi.hoisted(() => ({
  climb: undefined as undefined | Record<string, unknown>,
  climbFailed: false,
}));

const boardActions = vi.hoisted(() => ({
  saveClimb: vi.fn(),
  updateClimb: vi.fn(),
}));

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));

const createClimb = vi.hoisted(() => ({
  litUpHoldsMap: {} as Record<number, { state: string }>,
  frames: [{} as Record<number, { state: string }>],
  frameCount: 1,
  currentFrameIndex: 0,
  setHoldState: vi.fn(),
  generateFramesString: vi.fn(() => 'p1r12'),
  currentFrameBleString: vi.fn(() => ''),
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

vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'preview-uuid' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
// The controller reaches for nothing else from react-native — the autosave hook
// owns the only AppState use, and the announcer lives in the action bar.
vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
}));
// Partial, for two reasons: the controller now reads @boardsesh/board-config,
// which imports this package for real (SUPPORTED_BOARDS) — and only the two
// description helpers want stubbing here, since this suite is about which slot
// gets written, not about the `No match` wire convention. The characteristic
// helpers run for real; a hand-rolled copy of that table drifts from it the day
// a token is added.
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
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ refreshAuthState: vi.fn() }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { displayName: 'Tester' } }),
  useClimb: () => ({ data: graphql.climb, isError: graphql.climbFailed }),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ setCurrentClimb: vi.fn() }),
}));
vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => null,
}));
vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: toast.showToast }),
}));
vi.mock('../../../providers/dialog-provider', () => ({
  useConfirm: () => vi.fn(async () => true),
}));
vi.mock('../../../lib/climb-to-queue-item', () => ({ climbToQueueItem: () => ({}) }));
// Importing a name this factory doesn't list is an ESM error, not `undefined` —
// every export the controller pulls from the store has to appear here.
vi.mock('../../../lib/create-climb-draft-store', () => ({
  loadDraft: draftStore.loadDraft,
  saveDraft: draftStore.saveDraft,
  clearDraft: draftStore.clearDraft,
  createClimbDraftKey: draftStore.createClimbDraftKey,
  createClimbEditDraftKey: draftStore.createClimbEditDraftKey,
  createClimbForkDraftKey: draftStore.createClimbForkDraftKey,
  isDraftStorageAvailable: draftStore.isDraftStorageAvailable,
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

/** Keys `saveDraft` was called with, in order. */
function savedKeys(): string[] {
  return draftStore.saveDraft.mock.calls.map((call) => call[0] as string);
}

beforeEach(() => {
  draftStore.saveDraft.mockReset();
  draftStore.saveDraft.mockResolvedValue(undefined);
  draftStore.clearDraft.mockReset();
  draftStore.clearDraft.mockResolvedValue(undefined);
  draftStore.loadDraft.mockReset();
  draftStore.loadDraft.mockResolvedValue(null);
  draftStore.createClimbDraftKey.mockReset();
  draftStore.createClimbDraftKey.mockReturnValue('draft-key');
  boardActions.saveClimb.mockReset();
  boardActions.updateClimb.mockReset();
  graphql.climb = undefined;
  graphql.climbFailed = false;
  createClimb.frameCount = 1;
  createClimb.litUpHoldsMap = {};
  createClimb.frames = [{}];
  appState.listeners = [];
  appState.addEventListener.mockClear();
  toast.showToast.mockClear();
  draftStore.isDraftStorageAvailable.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCreateClimbScreen autosave flush', () => {
  it('flushes the pending draft on unmount instead of dropping the edit', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    // Let the mount restore resolve so restoredRef is set.
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    // Edit the name; do NOT advance past the 500ms debounce.
    act(() => result.current.setName('WIP name'));
    draftStore.saveDraft.mockClear();

    // Close the drawer (unmount) within the debounce window.
    unmount();

    // The pending edit must have been persisted synchronously on unmount.
    expect(draftStore.saveDraft).toHaveBeenCalledTimes(1);
    expect(draftStore.saveDraft.mock.calls[0]?.[1]?.name).toBe('WIP name');
  });

  it('flushes the pending draft when the app is backgrounded', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    act(() => result.current.setName('Background WIP'));
    draftStore.saveDraft.mockClear();

    act(() => appState.emit('background'));

    expect(draftStore.saveDraft).toHaveBeenCalledTimes(1);
    expect(draftStore.saveDraft.mock.calls[0]?.[1]?.name).toBe('Background WIP');
  });

  it('keeps autosaving after the first Save, carrying the saved-climb link', async () => {
    // The reported bug: Save a draft, keep painting, kill the app — everything
    // after the Save was gone, AND the Save had deleted the on-device copy too.
    boardActions.saveClimb.mockResolvedValue({ uuid: 'row-1', createdAt: null, publishedAt: null, isDraft: true });
    const { result, unmount } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    await waitFor(() => expect(draftStore.loadDraft).toHaveBeenCalled());

    act(() => result.current.setName('QA autosave'));
    await act(async () => {
      await result.current.handleSave();
    });
    expect(boardActions.saveClimb).toHaveBeenCalledTimes(1);

    draftStore.saveDraft.mockClear();
    act(() => result.current.setDescription('more beta after the save'));
    unmount();

    expect(savedKeys()).toEqual(['draft-key']);
    const payload = draftStore.saveDraft.mock.calls[0]?.[1] as {
      description?: string;
      savedClimbJson?: string;
      savedPayloadSignature?: string;
    };
    expect(payload.description).toBe('more beta after the save');
    // The link back to the server row, so a relaunch UPDATES it rather than
    // creating a second copy in Open drafts.
    expect(JSON.parse(payload.savedClimbJson ?? '{}')).toMatchObject({ uuid: 'row-1' });
    expect(payload.savedPayloadSignature).toBeTypeOf('string');
  });

  it('never clears the on-device copy on a draft-Save', async () => {
    boardActions.saveClimb.mockResolvedValue({ uuid: 'row-1', createdAt: null, publishedAt: null, isDraft: true });
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    await waitFor(() => expect(draftStore.loadDraft).toHaveBeenCalled());

    act(() => result.current.setName('Draft save'));
    await act(async () => {
      await result.current.handleSave();
    });

    expect(draftStore.clearDraft).not.toHaveBeenCalled();
    // It is REWRITTEN instead, so the slot stays the working copy.
    expect(savedKeys()).toContain('draft-key');
  });

  it('cancels an older debounced write before linking the slot to a saved row', async () => {
    vi.useFakeTimers();
    boardActions.saveClimb.mockResolvedValue({ uuid: 'row-1', createdAt: null, publishedAt: null, isDraft: true });
    let finishLinkedWrite: (() => void) | undefined;
    draftStore.saveDraft.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishLinkedWrite = resolve;
        }),
    );
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.setName('Link this working copy'));
    let pendingSave: Promise<void> | undefined;
    act(() => {
      pendingSave = result.current.handleSave();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(draftStore.saveDraft).toHaveBeenCalledTimes(1);
    expect(draftStore.saveDraft.mock.calls[0]?.[1]).toMatchObject({
      name: 'Link this working copy',
      savedClimbJson: expect.stringContaining('row-1'),
      savedPayloadSignature: expect.any(String),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(draftStore.saveDraft).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishLinkedWrite?.();
      await pendingSave;
    });
  });

  it('does not clear the slot on a publish when the payload moved mid-flight', async () => {
    // Compare-and-clear: the local write and the server round trip are
    // independent, so anything typed while the mutation was in flight would
    // otherwise be deleted by its success.
    let resolvePublish: ((value: unknown) => void) | undefined;
    boardActions.saveClimb.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePublish = resolve;
        }),
    );
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    await waitFor(() => expect(draftStore.loadDraft).toHaveBeenCalled());

    act(() => {
      result.current.setName('Publish me');
      result.current.setIsDraft(false);
    });

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.handleSave();
    });
    // ...and the climber keeps typing while the publish is in the air.
    act(() => result.current.setDescription('typed during the round trip'));
    await act(async () => {
      resolvePublish?.({ uuid: 'row-1', createdAt: null, publishedAt: null, isDraft: false });
      await pending;
    });

    expect(draftStore.clearDraft).not.toHaveBeenCalled();
  });

  it('clears the slot on a publish when nothing changed mid-flight', async () => {
    boardActions.saveClimb.mockResolvedValue({ uuid: 'row-1', createdAt: null, publishedAt: null, isDraft: false });
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    await waitFor(() => expect(draftStore.loadDraft).toHaveBeenCalled());

    act(() => {
      result.current.setName('Publish me');
      result.current.setIsDraft(false);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(draftStore.clearDraft).toHaveBeenCalledWith('draft-key');
  });

  it('writes a fork to its own slot and never to the shared new-climb key', async () => {
    const { result, unmount } = renderHook(() =>
      useCreateClimbScreen({ board: BOARD, forkFrames: 'p1r12', forkName: 'Original' }),
    );
    await waitFor(() => expect(result.current.name).toBe('Original remix'));

    vi.useFakeTimers();
    act(() => result.current.setDescription('forked beta'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    unmount();

    // A fork used to be locked out of autosave entirely, because writing the
    // board-config key would clobber a real new-climb WIP. Identity is in the key
    // now, so it saves — into `fork:`, never `draft-key`.
    expect(savedKeys()).toContain('fork:draft-key');
    expect(savedKeys().every((key) => key === 'fork:draft-key')).toBe(true);
  });

  it('restores a fork session from the plain creator when the new-climb slot is empty', async () => {
    // A killed remix can only be reached from a plain creator mount — the modal
    // route that carried `forkFrames` is gone by then.
    draftStore.loadDraft.mockImplementation(async (key: string) =>
      key === 'fork:draft-key'
        ? { holdsJson: '{}', framesJson: '[{}]', name: 'Rescued remix', description: '', isDraft: true }
        : null,
    );

    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    await waitFor(() => expect(result.current.name).toBe('Rescued remix'));
    expect(draftStore.loadDraft).toHaveBeenCalledWith('draft-key');
    expect(draftStore.loadDraft).toHaveBeenCalledWith('fork:draft-key');
    expect(draftStore.saveDraft).toHaveBeenCalledWith('draft-key', expect.objectContaining({ name: 'Rescued remix' }));
    expect(draftStore.clearDraft).toHaveBeenCalledWith('fork:draft-key');
    expect(draftStore.saveDraft.mock.invocationCallOrder[0]).toBeLessThan(
      draftStore.clearDraft.mock.invocationCallOrder[0],
    );
  });

  it('re-attaches the saved row from the restored slot so the next save updates it', async () => {
    draftStore.loadDraft.mockImplementation(async (key: string) =>
      key === 'draft-key'
        ? {
            holdsJson: '{}',
            framesJson: '[{}]',
            name: 'Restored',
            description: '',
            isDraft: true,
            savedClimbJson: JSON.stringify({
              uuid: 'row-1',
              boardType: 'kilter',
              createdAt: null,
              publishedAt: null,
              isDraft: true,
            }),
          }
        : null,
    );
    boardActions.updateClimb.mockResolvedValue({
      uuid: 'row-1',
      createdAt: null,
      publishedAt: null,
      isDraft: true,
    });

    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    await waitFor(() => expect(result.current.name).toBe('Restored'));

    // Legacy linked payloads predate savedPayloadSignature. They must be treated
    // conservatively as phone-only until the next successful explicit save.
    expect(result.current.draftStatus?.text).toBe('mobile.create.autosave.unsyncedEdits');

    await act(async () => {
      await result.current.handleSave();
    });

    // Without the re-attach this would take the create branch and leave a
    // duplicate row in Open drafts.
    expect(boardActions.updateClimb).toHaveBeenCalledTimes(1);
    expect(boardActions.saveClimb).not.toHaveBeenCalled();
  });

  it('ignores a corrupt saved-climb link but still restores the paint', async () => {
    draftStore.loadDraft.mockImplementation(async (key: string) =>
      key === 'draft-key'
        ? {
            holdsJson: '{}',
            framesJson: '[{}]',
            name: 'Corrupt link',
            description: '',
            isDraft: true,
            savedClimbJson: '{not json',
          }
        : null,
    );
    boardActions.saveClimb.mockResolvedValue({ uuid: 'new', createdAt: null, publishedAt: null, isDraft: true });

    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    await waitFor(() => expect(result.current.name).toBe('Corrupt link'));

    await act(async () => {
      await result.current.handleSave();
    });
    expect(boardActions.saveClimb).toHaveBeenCalledTimes(1);
  });

  it('autosaves an edit session into its own identity-keyed slot', async () => {
    graphql.climb = {
      uuid: 'climb-9',
      name: 'Server name',
      description: '',
      frames: 'p1r12',
      is_draft: true,
      created_at: null,
      published_at: null,
    };

    const { result, unmount } = renderHook(() => useCreateClimbScreen({ board: BOARD, editClimbUuid: 'climb-9' }));
    await waitFor(() => expect(result.current.name).toBe('Server name'));
    await waitFor(() => expect(draftStore.loadDraft).toHaveBeenCalledWith('edit:kilter:climb-9'));

    expect(result.current.draftStatus?.text).toBe('mobile.create.autosave.inAccount');

    draftStore.saveDraft.mockClear();
    act(() => result.current.setName('Edited name'));
    expect(result.current.draftStatus?.text).toBe('mobile.create.autosave.unsyncedEdits');
    unmount();

    // Editing a draft had NO autosave at all before — and the edit path is the
    // common one, since tapping a row in Open drafts lands here.
    expect(savedKeys()).toEqual(['edit:kilter:climb-9']);
    expect(draftStore.saveDraft.mock.calls[0]?.[1]?.name).toBe('Edited name');
  });

  it('applies the stored edit slot over the server copy, and writes nothing before it lands', async () => {
    // THE ordering hazard. `restoredRef` must open only after the `edit:` slot has
    // been applied: any earlier and the next debounce tick writes the freshly
    // fetched SERVER copy into the slot, destroying the unflushed edits this
    // restore exists to recover — silently. Reverse the ordering in
    // use-create-climb-screen.ts and both assertions below fail.
    graphql.climb = {
      uuid: 'climb-9',
      name: 'Server name',
      description: 'server beta',
      frames: 'p1r12',
      is_draft: true,
      created_at: null,
      published_at: null,
    };
    let releaseSlot: ((value: Record<string, unknown> | null) => void) | undefined;
    draftStore.loadDraft.mockImplementation(
      (key: string) =>
        new Promise((resolve) => {
          if (key !== 'edit:kilter:climb-9') {
            resolve(null);
            return;
          }
          releaseSlot = resolve;
        }),
    );

    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD, editClimbUuid: 'climb-9' }));
    await waitFor(() => expect(result.current.name).toBe('Server name'));
    await waitFor(() => expect(releaseSlot).toBeDefined());

    // While the slot is still in flight nothing may be persisted — the only
    // payload available right now is the server copy.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });
    expect(draftStore.saveDraft).not.toHaveBeenCalled();

    await act(async () => {
      releaseSlot?.({
        holdsJson: '{}',
        framesJson: '[{}]',
        name: 'Unflushed local name',
        description: 'local beta',
        isDraft: true,
      });
      await Promise.resolve();
    });

    // The local slot wins over the server copy...
    await waitFor(() => expect(result.current.name).toBe('Unflushed local name'));
    // ...and no write ever carried the server copy into the slot.
    expect(draftStore.saveDraft.mock.calls.every((call) => call[1]?.name !== 'Server name')).toBe(true);
  });

  it('moves to the new angle slot without the saved-row link, leaving the old angle alone', async () => {
    boardActions.saveClimb.mockResolvedValue({ uuid: 'row-1', createdAt: null, publishedAt: null, isDraft: true });
    draftStore.createClimbDraftKey.mockImplementation((config: { angle: number }) => `kilter:1:10:1,2:${config.angle}`);

    const { result, rerender, unmount } = renderHook(
      (props: { angle: number }) => useCreateClimbScreen({ board: { ...BOARD, angle: props.angle } }),
      { initialProps: { angle: 40 } },
    );
    await waitFor(() => expect(draftStore.loadDraft).toHaveBeenCalled());
    act(() => result.current.setName('Angled'));
    await act(async () => {
      await result.current.handleSave();
    });

    draftStore.saveDraft.mockClear();
    rerender({ angle: 25 });
    act(() => result.current.setDescription('at the new angle'));
    unmount();

    // Each angle owns its own slot, and the row link is dropped with the angle
    // (the detach effect nulls savedClimb, so the payload can't carry it).
    expect(savedKeys()).toEqual(['kilter:1:10:1,2:25']);
    expect(draftStore.saveDraft.mock.calls[0]?.[1]?.savedClimbJson).toBeUndefined();
  });

  it('tells you the draft was kept only when it is nowhere else to be found', async () => {
    // The one conditional toast on dismiss. Silent when the work is already a row
    // in Open drafts (the status line said so), and silent for an empty editor —
    // a notice on every close is noise, and noise on the most-used gesture on
    // this surface is how confirms get trained away.
    boardActions.saveClimb.mockResolvedValue({ uuid: 'row-1', createdAt: null, publishedAt: null, isDraft: true });
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    await waitFor(() => expect(draftStore.loadDraft).toHaveBeenCalled());

    // Empty editor: nothing to lose, nothing to say.
    act(() => result.current.notifyDraftKeptOnDismiss());
    expect(toast.showToast).not.toHaveBeenCalled();

    // Painted but never saved: this is the case a climber could think is gone.
    act(() => result.current.setName('Unsaved WIP'));
    act(() => result.current.notifyDraftKeptOnDismiss());
    expect(toast.showToast).toHaveBeenCalledTimes(1);
    expect(toast.showToast.mock.calls[0]?.[0]).toBe('mobile.create.autosave.keptToast');

    // Saved to the account: it is in Open drafts, so stay quiet. (Clear after the
    // save, whose own "Draft saved" toast is a separate, wanted one.)
    await act(async () => {
      await result.current.handleSave();
    });
    toast.showToast.mockClear();
    act(() => result.current.notifyDraftKeptOnDismiss());
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('stays quiet on dismiss when nothing could be stored in the first place', async () => {
    // Signed-out expo-web writes nothing at all, so promising a kept draft would
    // be a lie. The status line already says "Sign in to keep this draft".
    draftStore.isDraftStorageAvailable.mockReturnValue(false);
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    await waitFor(() => expect(draftStore.loadDraft).toHaveBeenCalled());

    act(() => result.current.setName('Anonymous WIP'));
    act(() => result.current.notifyDraftKeptOnDismiss());

    expect(toast.showToast).not.toHaveBeenCalled();
    expect(result.current.draftStatus).toEqual({
      text: 'mobile.create.autosave.notStored',
      tone: 'warning',
      announce: true,
    });
  });

  it('blocks publishing a climb with no start or finish, and says why', async () => {
    // `isValid` is `totalHolds > 0` and SaveClimbInputSchema checks neither end,
    // so without this a one-hold blob is one tap from being a public climb.
    createClimb.canPublish = false;
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    await waitFor(() => expect(draftStore.loadDraft).toHaveBeenCalled());
    act(() => result.current.setName('One blob'));

    // A DRAFT save is unaffected — drafts stay cheap.
    expect(result.current.publishBlocked).toBe(false);

    act(() => result.current.setIsDraft(false));
    expect(result.current.publishBlocked).toBe(true);
    expect(result.current.draftStatus).toEqual({
      text: 'mobile.create.publish.blocked',
      tone: 'warning',
      announce: true,
    });

    await act(async () => {
      await result.current.handleSave();
    });
    expect(boardActions.saveClimb).not.toHaveBeenCalled();

    createClimb.canPublish = true;
  });

  it('restores the edit slot before autosaving when the climb never loads', async () => {
    // If the query fails permanently — offline, or the row is gone — the seed
    // effect never runs. Gate autosave on it and the whole edit session silently
    // stops saving: paint, kill the app, lose everything. That is the exact
    // failure this change exists to remove, so the gate opens on the failure too.
    graphql.climb = undefined;
    graphql.climbFailed = true;
    draftStore.loadDraft.mockResolvedValue({
      holdsJson: '{}',
      framesJson: '[{}]',
      name: 'Recovered offline edit',
      description: 'phone beta',
      isDraft: true,
    });

    const { result, unmount } = renderHook(() => useCreateClimbScreen({ board: BOARD, editClimbUuid: 'climb-9' }));
    await waitFor(() => expect(result.current.name).toBe('Recovered offline edit'));
    expect(draftStore.saveDraft).not.toHaveBeenCalled();
    act(() => result.current.setName('Painted while offline'));
    unmount();

    expect(savedKeys()).toEqual(['edit:kilter:climb-9']);
    expect(draftStore.saveDraft.mock.calls[0]?.[1]?.name).toBe('Painted while offline');
  });

  it('does not overwrite a failure-restored edit when the server retry later succeeds', async () => {
    graphql.climbFailed = true;
    draftStore.loadDraft.mockResolvedValue({
      holdsJson: '{}',
      framesJson: '[{}]',
      name: 'Recovered offline edit',
      description: 'phone beta',
      isDraft: true,
    });

    const { result, rerender } = renderHook(() => useCreateClimbScreen({ board: BOARD, editClimbUuid: 'climb-9' }));
    await waitFor(() => expect(result.current.name).toBe('Recovered offline edit'));

    graphql.climbFailed = false;
    graphql.climb = {
      uuid: 'climb-9',
      name: 'Older server name',
      description: 'server beta',
      frames: 'p1r12',
      is_draft: true,
      created_at: null,
      published_at: null,
    };
    rerender();

    await waitFor(() => expect(result.current.draftStatus?.text).toBe('mobile.create.autosave.unsyncedEdits'));
    expect(result.current.name).toBe('Recovered offline edit');
  });

  it('keeps current-session edits when a found failure restore finishes late', async () => {
    graphql.climbFailed = true;
    let finishRestore: ((draft: Record<string, unknown> | null) => void) | undefined;
    draftStore.loadDraft.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRestore = resolve;
        }),
    );

    const { result, rerender } = renderHook(() => useCreateClimbScreen({ board: BOARD, editClimbUuid: 'climb-9' }));
    await waitFor(() => expect(finishRestore).toBeDefined());
    act(() => result.current.setName('Typed while storage was loading'));

    graphql.climbFailed = false;
    graphql.climb = {
      uuid: 'climb-9',
      name: 'Server retry',
      description: 'server beta',
      frames: 'p1r12',
      is_draft: true,
      created_at: null,
      published_at: null,
    };
    rerender();

    await act(async () => {
      finishRestore?.({
        holdsJson: '{}',
        framesJson: '[{}]',
        name: 'Phone copy still loading',
        description: 'phone beta',
        isDraft: true,
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.name).toBe('Typed while storage was loading'));
    expect(result.current.draftStatus?.text).toBe('mobile.create.autosave.unsyncedEdits');
  });

  it('keeps current-session edits when an empty failure restore finishes late', async () => {
    graphql.climbFailed = true;
    let finishRestore: ((draft: null) => void) | undefined;
    draftStore.loadDraft.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRestore = resolve;
        }),
    );
    const { result, rerender } = renderHook(() => useCreateClimbScreen({ board: BOARD, editClimbUuid: 'climb-9' }));
    await waitFor(() => expect(finishRestore).toBeDefined());
    act(() => result.current.setName('Typed before empty result'));

    await act(async () => {
      finishRestore?.(null);
      await Promise.resolve();
    });
    graphql.climbFailed = false;
    graphql.climb = {
      uuid: 'climb-9',
      name: 'Older server name',
      description: 'server beta',
      frames: 'p1r12',
      is_draft: true,
      created_at: null,
      published_at: null,
    };
    rerender();

    await waitFor(() => expect(result.current.draftStatus?.text).toBe('mobile.create.autosave.unsyncedEdits'));
    expect(result.current.name).toBe('Typed before empty result');
  });

  it('arms autosave for an edit made while the failure restore was pending', async () => {
    graphql.climbFailed = true;
    let finishRestore: ((draft: null) => void) | undefined;
    draftStore.loadDraft.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRestore = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useCreateClimbScreen({ board: BOARD, editClimbUuid: 'climb-9' }));
    await waitFor(() => expect(finishRestore).toBeDefined());
    act(() => result.current.setName('Typed before restore opened'));

    await act(async () => {
      finishRestore?.(null);
      await Promise.resolve();
    });
    draftStore.saveDraft.mockClear();
    unmount();

    expect(draftStore.saveDraft).toHaveBeenCalledWith(
      'edit:kilter:climb-9',
      expect.objectContaining({ name: 'Typed before restore opened' }),
    );
  });

  it('keeps edits made after an empty offline restore when the server retry succeeds', async () => {
    graphql.climbFailed = true;
    draftStore.loadDraft.mockResolvedValue(null);
    const { result, rerender } = renderHook(() => useCreateClimbScreen({ board: BOARD, editClimbUuid: 'climb-9' }));
    await waitFor(() => expect(draftStore.loadDraft).toHaveBeenCalledWith('edit:kilter:climb-9'));

    act(() => result.current.setName('Typed while offline'));
    graphql.climbFailed = false;
    graphql.climb = {
      uuid: 'climb-9',
      name: 'Older server name',
      description: 'server beta',
      frames: 'p1r12',
      is_draft: true,
      created_at: null,
      published_at: null,
    };
    rerender();

    await waitFor(() => expect(result.current.draftStatus?.text).toBe('mobile.create.autosave.unsyncedEdits'));
    expect(result.current.name).toBe('Typed while offline');
  });

  it('leaves edit identity before starting a fresh climb', async () => {
    graphql.climbFailed = true;
    draftStore.loadDraft.mockResolvedValue({
      holdsJson: '{}',
      framesJson: '[{}]',
      name: 'Offline edit',
      description: '',
      isDraft: true,
    });
    const onStartedNewClimb = vi.fn();
    const { result } = renderHook(() =>
      useCreateClimbScreen({ board: BOARD, editClimbUuid: 'climb-9', onStartedNewClimb }),
    );
    await waitFor(() => expect(result.current.name).toBe('Offline edit'));

    act(() => result.current.handleNewClimb());
    await act(async () => {
      result.current.confirmNewClimb();
      await Promise.resolve();
    });

    expect(draftStore.clearDraft).toHaveBeenCalledWith('edit:kilter:climb-9');
    expect(onStartedNewClimb).toHaveBeenCalledTimes(1);
  });

  it('does not navigate after a pending Start new clear outlives the screen', async () => {
    graphql.climbFailed = true;
    draftStore.loadDraft.mockResolvedValue({
      holdsJson: '{}',
      framesJson: '[{}]',
      name: 'Offline edit',
      description: '',
      isDraft: true,
    });
    let finishClear: (() => void) | undefined;
    draftStore.clearDraft.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        }),
    );
    const onStartedNewClimb = vi.fn();
    const { result, unmount } = renderHook(() =>
      useCreateClimbScreen({ board: BOARD, editClimbUuid: 'climb-9', onStartedNewClimb }),
    );
    await waitFor(() => expect(result.current.name).toBe('Offline edit'));

    act(() => result.current.handleNewClimb());
    act(() => result.current.confirmNewClimb());
    unmount();
    await act(async () => {
      finishClear?.();
      await Promise.resolve();
    });

    expect(onStartedNewClimb).not.toHaveBeenCalled();
  });

  it('drops the slot this session owns when starting a new climb, not always the new-climb one', async () => {
    // Clearing only the board-config key left an abandoned fork slot behind, and
    // the plain creator's fork fallback would then resurrect it as a ghost draft
    // on the next open.
    const { result } = renderHook(() =>
      useCreateClimbScreen({ board: BOARD, forkFrames: 'p1r12', forkName: 'Original' }),
    );
    await waitFor(() => expect(result.current.name).toBe('Original remix'));
    draftStore.clearDraft.mockClear();

    // A fork carries content and no saved row, so this asks inline first.
    act(() => result.current.handleNewClimb());
    await act(async () => {
      result.current.confirmNewClimb();
      await Promise.resolve();
    });

    expect(draftStore.clearDraft).toHaveBeenCalledWith('fork:draft-key');
    expect(draftStore.clearDraft).not.toHaveBeenCalledWith('draft-key');
  });

  it('cannot show a stale save failure once the draft toggle moves', async () => {
    // Review raised the case where `saveFailed` and `publishBlocked` are both
    // true and the failure hides the publish reason. It is unreachable, and this
    // pins WHY: `isDraft` is part of the payload signature, so flipping the
    // toggle moves the signature and retires the recorded failure with it.
    // Drop `isDraft` from the signature and this goes red.
    boardActions.saveClimb.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));
    await waitFor(() => expect(draftStore.loadDraft).toHaveBeenCalled());

    act(() => result.current.setName('Will fail'));
    await act(async () => {
      await result.current.handleSave();
    });
    expect(result.current.draftStatus).toEqual({
      text: 'mobile.create.autosave.saveFailed',
      tone: 'error',
      announce: true,
    });

    // Switching to publish is a payload change, so the failure does not linger.
    act(() => result.current.setIsDraft(false));
    expect(result.current.draftStatus?.text).not.toBe('mobile.create.autosave.saveFailed');
  });
});
