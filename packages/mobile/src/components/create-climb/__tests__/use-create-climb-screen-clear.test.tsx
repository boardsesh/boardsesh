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
}));

vi.mock('@boardsesh/create-climb-react', () => ({
  useCreateClimb: () => createClimb,
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
});

describe('useCreateClimbScreen handleClear', () => {
  it('resets the No-match toggle so a brand-new climb is not silently tagged no-match', async () => {
    board.saveClimb.mockResolvedValue({ uuid: 'fresh', createdAt: null, publishedAt: null, isDraft: true });

    const { result } = renderHook(() => useCreateClimbScreen({ board: BOARD }));

    // The previous climb used the No-match rule.
    act(() => result.current.setNoMatch(true));
    await waitFor(() => expect(result.current.noMatch).toBe(true));

    // Start fresh.
    act(() => result.current.handleClear());

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
});
