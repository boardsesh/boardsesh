// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The spray-wall branch of the create controller (#5443): the setter grade that
// gates a publish, the any-feet default and the FOOT-hold rule that keeps it
// honest, and the wall identity (angle + uuid) every write has to carry.
//
// The real registry runs here on purpose — the angle and the uuid come from it,
// and a hand-rolled stand-in is exactly what would let a "wrong angle on every
// spray climb" regression pass.

const ble = vi.hoisted(() => ({ context: null as null | Record<string, unknown> }));
const graphql = vi.hoisted(() => ({
  climb: undefined as undefined | Record<string, unknown>,
  climbFailed: false,
}));
const boardActions = vi.hoisted(() => ({ saveClimb: vi.fn(), updateClimb: vi.fn() }));
const queue = vi.hoisted(() => ({ setCurrentClimb: vi.fn() }));
const draftStore = vi.hoisted(() => ({
  loadDraft: vi.fn(async () => null as null | Record<string, unknown>),
  saveDraft: vi.fn(async () => {}),
  clearDraft: vi.fn(async () => {}),
}));

const createClimb = vi.hoisted(() => ({
  litUpHoldsMap: { 1: { state: 'STARTING' }, 2: { state: 'FINISH' } } as Record<number, { state: string }>,
  frames: [{ 1: { state: 'STARTING' } }] as Array<Record<number, { state: string }>>,
  frameCount: 1,
  currentFrameIndex: 0,
  setHoldState: vi.fn(),
  generateFramesString: vi.fn(() => 'p1r1p2r3'),
  currentFrameBleString: vi.fn(() => 'p1r1p2r3'),
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

vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'preview-uuid' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
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
  useClimb: () => ({ data: graphql.climb, isError: graphql.climbFailed }),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ setCurrentClimb: queue.setCurrentClimb }),
}));
vi.mock('../../../providers/bluetooth-provider', () => ({ useOptionalBluetoothContext: () => ble.context }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock('../../../lib/climb-to-queue-item', () => ({
  climbToQueueItem: (climb: unknown) => ({ uuid: 'queue-item', climb }),
}));
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
  getPaintRoles: () => ['STARTING', 'HAND', 'FINISH', 'FOOT'],
  computeRoleCapacity: () => ({}),
  getNextBrushRole: () => 'HAND',
}));

import { clearSprayWallRegistry, registerSprayWall } from '../../../lib/spray/spray-wall-registry';
import { useCreateClimbScreen } from '../use-create-climb-screen';

const LAYOUT_ID = 9001;
const SPRAY_BOARD = {
  boardName: 'spray' as const,
  layoutId: LAYOUT_ID,
  sizeId: LAYOUT_ID,
  setIds: '1',
  // Deliberately NOT the wall's angle: the route params are what a stale deep
  // link or the active board hands over, and the wall has to win.
  angle: 40,
};
const KILTER_BOARD = { boardName: 'kilter' as const, layoutId: 8, sizeId: 17, setIds: '26,27', angle: 40 };

/** `6c/V5` on the shared Boardsesh scale. */
const SIX_C_DIFFICULTY_ID = 20;

function registerWall(angle: number) {
  registerSprayWall(LAYOUT_ID, {
    wallUuid: 'wall-uuid',
    angle,
    version: 1,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: 'https://private.example/photo',
    photoThumbUrl: null,
    photoExpiresAt: '2026-09-15T12:15:00.000Z',
    holds: [{ id: 1, cx: 100, cy: 200, r: 18 }],
  });
}

beforeEach(() => {
  ble.context = null;
  graphql.climb = undefined;
  graphql.climbFailed = false;
  createClimb.litUpHoldsMap = { 1: { state: 'STARTING' }, 2: { state: 'FINISH' } };
  boardActions.saveClimb.mockReset();
  boardActions.saveClimb.mockResolvedValue({ uuid: 'saved-1', createdAt: null, publishedAt: null, isDraft: false });
  boardActions.updateClimb.mockReset();
  boardActions.updateClimb.mockResolvedValue({ uuid: 'saved-1', createdAt: null, publishedAt: null, isDraft: false });
  queue.setCurrentClimb.mockReset();
  draftStore.loadDraft.mockReset();
  draftStore.loadDraft.mockResolvedValue(null);
  draftStore.saveDraft.mockReset();
  draftStore.saveDraft.mockResolvedValue(undefined);
  registerWall(25);
});

afterEach(() => {
  clearSprayWallRegistry();
});

describe('the setter grade gates a publish', () => {
  it('shows the grade row on a wall and hides it on a catalogue board', () => {
    const { result: spray } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));
    const { result: kilter } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));
    expect(spray.current.showSetterGrade).toBe(true);
    expect(kilter.current.showSetterGrade).toBe(false);
  });

  it('blocks a publish with no grade, and says the grade is why', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => {
      result.current.setName('Slopey traverse');
      result.current.setIsDraft(false);
    });

    expect(result.current.setterGradeMissing).toBe(true);
    expect(result.current.publishBlocked).toBe(true);
    expect(result.current.draftStatus?.text).toBe('mobile.create.publish.gradeBlocked');
  });

  it('refuses to write anything while the grade is missing', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => {
      result.current.setName('Slopey traverse');
      result.current.setIsDraft(false);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.saveClimb).not.toHaveBeenCalled();
  });

  it('lets the publish through once a grade is picked, and sends it', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => {
      result.current.setName('Slopey traverse');
      result.current.setIsDraft(false);
      result.current.setSetterGradeDifficultyId(SIX_C_DIFFICULTY_ID);
    });
    expect(result.current.publishBlocked).toBe(false);

    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.saveClimb).toHaveBeenCalledWith(expect.objectContaining({ user_grade: '6c/V5' }));
  });

  it('leaves a DRAFT saveable with no grade', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => result.current.setName('Work in progress'));
    expect(result.current.setterGradeMissing).toBe(false);
    expect(result.current.publishBlocked).toBe(false);

    await act(async () => {
      await result.current.handleSave();
    });

    const payload = boardActions.saveClimb.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.is_draft).toBe(true);
    expect(payload.user_grade).toBeUndefined();
  });

  it('carries the grade on the update path, so an ungraded draft can still publish', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => result.current.setName('Draft first'));
    await act(async () => {
      await result.current.handleSave();
    });

    act(() => {
      result.current.setIsDraft(false);
      result.current.setSetterGradeDifficultyId(SIX_C_DIFFICULTY_ID);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.updateClimb).toHaveBeenCalledWith(expect.objectContaining({ userGrade: '6c/V5' }));
  });

  it('never asks a catalogue board for one', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));
    act(() => result.current.setIsDraft(false));
    expect(result.current.setterGradeMissing).toBe(false);
  });
});

describe('any feet on a wall', () => {
  it('starts on', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));
    expect(result.current.anyFeet).toBe(true);
  });

  it('turns off when the climb gains a foot hold, and back on when it loses it', async () => {
    const { result, rerender } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));
    expect(result.current.anyFeet).toBe(true);

    createClimb.litUpHoldsMap = { 1: { state: 'STARTING' }, 2: { state: 'FINISH' }, 3: { state: 'FOOT' } };
    rerender();
    await waitFor(() => expect(result.current.anyFeet).toBe(false));

    createClimb.litUpHoldsMap = { 1: { state: 'STARTING' }, 2: { state: 'FINISH' } };
    rerender();
    await waitFor(() => expect(result.current.anyFeet).toBe(true));
  });

  it('leaves a hand-set switch alone while the feet do not change', async () => {
    const { result, rerender } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    createClimb.litUpHoldsMap = { 1: { state: 'STARTING' }, 2: { state: 'FINISH' }, 3: { state: 'FOOT' } };
    rerender();
    await waitFor(() => expect(result.current.anyFeet).toBe(false));

    act(() => result.current.setAnyFeet(true));
    createClimb.litUpHoldsMap = { 1: { state: 'STARTING' }, 2: { state: 'FINISH' }, 3: { state: 'FOOT' } };
    rerender();
    expect(result.current.anyFeet).toBe(true);
  });

  it('leaves a catalogue board with its feet closed by default', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));
    expect(result.current.anyFeet).toBe(false);
  });
});

describe('the wall owns the angle and the identity', () => {
  it('publishes at the wall angle, not at the route param', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => {
      result.current.setName('At the wall angle');
      result.current.setIsDraft(false);
      result.current.setSetterGradeDifficultyId(SIX_C_DIFFICULTY_ID);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.saveClimb.mock.calls[0][0].angle).toBe(25);
  });

  it('presents the wall uuid on every spray write', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => result.current.setName('Share-link crew'));
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.saveClimb.mock.calls[0][0].spray_wall_uuid).toBe('wall-uuid');
  });

  it('sends neither on a catalogue board', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));

    act(() => result.current.setName('Ordinary climb'));
    await act(async () => {
      await result.current.handleSave();
    });

    const payload = boardActions.saveClimb.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.angle).toBe(40);
    expect(payload.spray_wall_uuid).toBeUndefined();
    expect(payload.user_grade).toBeUndefined();
  });
});
