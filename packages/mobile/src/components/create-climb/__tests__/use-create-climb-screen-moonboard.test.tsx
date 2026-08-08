// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const boardActions = vi.hoisted(() => ({
  saveClimb: vi.fn(),
  updateClimb: vi.fn(),
  saveMoonBoardClimb: vi.fn(),
  updateMoonBoardClimb: vi.fn(),
}));
const roles = vi.hoisted(() => ({
  assignments: [] as Array<{ role: string; boardType: string | null }>,
}));
const editClimb = vi.hoisted(() => ({ data: undefined as unknown }));
const createClimb = vi.hoisted(() => ({
  litUpHoldsMap: {
    26: { state: 'STARTING' },
    80: { state: 'HAND' },
    190: { state: 'FINISH' },
  },
  setHoldState: vi.fn(),
  generateFramesString: vi.fn(() => 'aurora-frames-should-not-be-used'),
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

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'preview-uuid' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@boardsesh/shared-schema', () => ({
  getMoonBoardMethod: (characteristics: string[] | null | undefined) =>
    characteristics?.find((token) => token.startsWith('method_')) ?? null,
  isNoMatchClimb: () => false,
  withNoMatch: (description: string) => description,
}));
vi.mock('@boardsesh/board-config', () => ({
  convertLitUpHoldsMapToMoonBoardHolds: () => ({ start: ['C3'], hand: ['D8'], finish: ['D18'] }),
  encodeMoonBoardHoldsToFrames: () => 'p26r42p80r43p190r44',
  MOONBOARD_ANGLES: [25, 40],
  MOONBOARD_GRADES: [
    { value: '7A', label: '7a/V6' },
    { value: '7B', label: '7b/V8' },
  ],
}));
vi.mock('@boardsesh/create-climb-react', () => ({
  useCreateClimb: () => createClimb,
  computeCanUpdate: (savedClimb: unknown) => savedClimb != null,
  computeEditLocked: () => false,
  buildInitialHoldsMap: () => ({}),
}));
vi.mock('@boardsesh/board-react', () => ({
  useBoardActions: () => ({ isAuthenticated: true, ...boardActions }),
  isDuplicateClimbError: () => false,
}));
vi.mock('@boardsesh/graphql-client', () => ({
  GraphQLOperationError: class GraphQLOperationError extends Error {},
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ refreshAuthState: vi.fn() }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { displayName: 'Moon Setter' } }),
  useClimb: () => ({ data: editClimb.data }),
  useMyRoles: () => ({ data: roles.assignments }),
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
  loadDraft: vi.fn(async () => null),
  saveDraft: vi.fn(async () => {}),
  clearDraft: vi.fn(async () => {}),
  createClimbDraftKey: () => 'moonboard-draft-key',
}));
vi.mock('../brush-roles', () => ({
  getPaintRoles: () => ['HAND', 'STARTING', 'FINISH'],
}));

import { useCreateClimbScreen } from '../use-create-climb-screen';

const MOON_BOARD = {
  boardName: 'moonboard' as const,
  layoutId: 2,
  sizeId: 1,
  setIds: '2,3,4',
  angle: 40,
};

beforeEach(() => {
  roles.assignments = [];
  editClimb.data = undefined;
  for (const mutation of Object.values(boardActions)) mutation.mockReset();
});

describe('useCreateClimbScreen MoonBoard saves', () => {
  it('publishes the full MoonBoard create payload for an authorized benchmark setter', async () => {
    roles.assignments = [{ role: 'community_leader', boardType: 'moonboard' }];
    boardActions.saveMoonBoardClimb.mockResolvedValue({ uuid: 'moon-new', publishedAt: 'now' });
    const { result } = renderHook(() => useCreateClimbScreen({ board: MOON_BOARD }));

    act(() => {
      result.current.setName('Full Moon');
      result.current.setMoonboardAngle(25);
      result.current.setMoonboardGrade('7A');
      result.current.setMoonboardMethod('method_footless');
      result.current.setMoonboardBenchmark(true);
      result.current.setIsDraft(false);
    });
    await act(async () => result.current.handleSave());

    expect(boardActions.saveMoonBoardClimb).toHaveBeenCalledWith({
      boardType: 'moonboard',
      layoutId: 2,
      name: 'Full Moon',
      description: '',
      holds: { start: ['C3'], hand: ['D8'], finish: ['D18'] },
      angle: 25,
      isDraft: false,
      userGrade: '7A',
      method: 'method_footless',
      isBenchmark: true,
    });
    expect(boardActions.saveClimb).not.toHaveBeenCalled();
  });

  it('hydrates a MoonBoard draft and repeatedly updates the same UUID', async () => {
    roles.assignments = [{ role: 'admin', boardType: null }];
    editClimb.data = {
      uuid: 'moon-existing',
      name: 'Existing Moon',
      description: 'Beta',
      frames: 'p26r42p80r43p190r44',
      angle: 25,
      difficulty: '7a/V6',
      characteristics: ['method_no_kickboard'],
      benchmark_difficulty: '7A',
      is_draft: true,
      created_at: '2026-01-01T00:00:00.000Z',
      published_at: null,
    };
    boardActions.updateMoonBoardClimb.mockResolvedValue({
      uuid: 'moon-existing',
      isDraft: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      publishedAt: null,
    });
    const { result } = renderHook(() => useCreateClimbScreen({ board: MOON_BOARD, editClimbUuid: 'moon-existing' }));

    await waitFor(() => expect(result.current.moonboardGrade).toBe('7A'));
    expect(result.current.moonboardAngle).toBe(25);
    expect(result.current.moonboardMethod).toBe('method_no_kickboard');
    expect(result.current.moonboardBenchmark).toBe(true);

    await act(async () => result.current.handleSave());
    await act(async () => result.current.handleSave());

    expect(boardActions.updateMoonBoardClimb).toHaveBeenCalledTimes(2);
    expect(boardActions.updateMoonBoardClimb).toHaveBeenLastCalledWith(
      expect.objectContaining({ uuid: 'moon-existing', boardType: 'moonboard', angle: 25, userGrade: '7A' }),
    );
    expect(boardActions.updateClimb).not.toHaveBeenCalled();
  });
});
