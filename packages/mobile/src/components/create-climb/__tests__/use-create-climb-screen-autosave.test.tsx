// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercises the local-autosave effect's persistence guarantees:
//  1. Flush-on-unmount: a pending debounced edit must be written immediately
//     when the screen unmounts (drawer close / navigation), instead of being
//     dropped by the cleanup's clearTimeout.
//  2. Fork isolation: opening a fork must never overwrite the shared per-board
//     new-climb autosave slot.

const draftStore = vi.hoisted(() => ({
  loadDraft: vi.fn(async () => null),
  saveDraft: vi.fn(async (_key: string, _draft: { name: string }) => {}),
  clearDraft: vi.fn(async () => {}),
  createClimbDraftKey: vi.fn(() => 'draft-key'),
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

const createClimb = vi.hoisted(() => ({
  litUpHoldsMap: {} as Record<number, { state: string }>,
  setHoldState: vi.fn(),
  generateFramesString: vi.fn(() => ''),
  startingCount: 0,
  finishCount: 0,
  isValid: false,
  resetHolds: vi.fn(),
  loadHolds: vi.fn(),
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
vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
}));
vi.mock('@boardsesh/shared-schema', () => ({
  isNoMatchClimb: () => false,
  withNoMatch: (description: string) => description,
}));
vi.mock('@boardsesh/create-climb-react', () => ({
  useCreateClimb: () => createClimb,
  computeCanUpdate: (savedClimb: unknown) => savedClimb != null,
  computeEditLocked: () => false,
  buildInitialHoldsMap: () => ({}),
}));
vi.mock('@boardsesh/board-react', () => ({
  useBoardProvider: () => ({
    isAuthenticated: true,
    saveClimb: vi.fn(),
    updateClimb: vi.fn(),
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
  useQueueActions: () => ({ setCurrentClimb: vi.fn() }),
}));
vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => null,
}));
vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../../../lib/climb-to-queue-item', () => ({ climbToQueueItem: () => ({}) }));
vi.mock('../../../lib/create-climb-draft-store', () => ({
  loadDraft: draftStore.loadDraft,
  saveDraft: draftStore.saveDraft,
  clearDraft: draftStore.clearDraft,
  createClimbDraftKey: draftStore.createClimbDraftKey,
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
  draftStore.saveDraft.mockClear();
  draftStore.clearDraft.mockClear();
  draftStore.loadDraft.mockClear();
  draftStore.createClimbDraftKey.mockReturnValue('draft-key');
  appState.listeners = [];
  appState.addEventListener.mockClear();
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

  it('does not write the shared new-climb slot when forking (debounced or flush)', async () => {
    const { result, unmount } = renderHook(() =>
      useCreateClimbScreen({ board: BOARD, forkFrames: 'p1r12', forkName: 'Original' }),
    );
    // A fork seeds its own holds/name; let any restore settle.
    await waitFor(() => expect(result.current.name).toBe('Original remix'));

    vi.useFakeTimers();
    act(() => result.current.setDescription('forked beta'));
    // Run past the debounce window — a non-fork WIP would persist here.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // And exercise the unmount-flush path too.
    unmount();

    // Forks seed from their source and skip restore, so they must never persist
    // into the per-board new-climb autosave key (it would clobber a real WIP).
    expect(draftStore.saveDraft).not.toHaveBeenCalled();
  });
});
