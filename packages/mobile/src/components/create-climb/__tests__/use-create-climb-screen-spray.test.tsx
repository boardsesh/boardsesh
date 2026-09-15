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
/** The holds `buildInitialFrames` hands back for a fork. */
const forkSeed = vi.hoisted(() => ({ frame: {} as Record<number, { state: string }> }));
/** What the stubbed `createClimbDraftKey` folds in, standing in for the registry. */
const sprayToken = vi.hoisted(() => ({ current: '' }));
const queue = vi.hoisted(() => ({ setCurrentClimb: vi.fn() }));
const draftStore = vi.hoisted(() => ({
  loadDraft: vi.fn(async () => null as null | Record<string, unknown>),
  // Typed with its real arity so a test can read the slot key off the call.
  saveDraft: vi.fn(async (_slotKey: string, _draft: Record<string, unknown>) => {}),
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
  // The real seeder turns a frames string into a LitUpHoldsMap; the fork's paint
  // is what the any-feet seed has to read, so the stub has to carry it.
  buildInitialFrames: () => [forkSeed.frame],
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
  // Mirrors the real key's shape closely enough to observe the one thing this
  // suite cares about: the wall version it folds in.
  createClimbDraftKey: (config: { boardName: string; layoutId: number }) =>
    `draft-key:${config.boardName}:${config.layoutId}${sprayToken.current}`,
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
import { getPreference, removePreference, setPreference } from '../../../lib/preference-store';
import { lastUsedGradeKey } from '../use-last-used-grade';
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
  forkSeed.frame = {};
  sprayToken.current = '';
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

afterEach(async () => {
  clearSprayWallRegistry();
  await removePreference(lastUsedGradeKey('spray'));
  await removePreference(lastUsedGradeKey('kilter'));
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

  it('sends a changed grade on a plain edit, not only on the publish transition', async () => {
    // The backend applies this now (`updateClimb`'s spray grade-edit branch); the
    // client half is that it is on the wire for every spray update, not just the
    // draft -> publish one.
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => {
      result.current.setName('Published, then regraded');
      result.current.setIsDraft(false);
      result.current.setSetterGradeDifficultyId(SIX_C_DIFFICULTY_ID);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    // 7a/V6 — a regrade of a climb that already has a graded stats row.
    act(() => result.current.setSetterGradeDifficultyId(22));
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.updateClimb).toHaveBeenCalledWith(expect.objectContaining({ userGrade: '7a/V6' }));
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

  // `saveClimb` stores NULL, not `[]`, when a climb carries no rule tokens — and
  // "feet on the marked holds" is no token. So the commonest wall climb there is
  // (marked feet, any-feet off) remixes with NO characteristics param at all, and
  // the board default would hand it back open over its own FOOT holds.
  it('opens a rule-less remix of a feet-marked wall climb with any feet OFF', () => {
    forkSeed.frame = { 1: { state: 'STARTING' }, 2: { state: 'FOOT' }, 3: { state: 'FINISH' } };
    createClimb.litUpHoldsMap = forkSeed.frame;
    const { result } = renderHook(() =>
      useCreateClimbScreen({ board: SPRAY_BOARD, forkFrames: 'p1r1p2r4p3r3', forkName: 'Parent' }),
    );
    expect(result.current.anyFeet).toBe(false);
  });

  it('opens a rule-less remix of a feet-free wall climb with any feet ON', () => {
    forkSeed.frame = { 1: { state: 'STARTING' }, 2: { state: 'FINISH' } };
    createClimb.litUpHoldsMap = forkSeed.frame;
    const { result } = renderHook(() =>
      useCreateClimbScreen({ board: SPRAY_BOARD, forkFrames: 'p1r1p2r3', forkName: 'Parent' }),
    );
    expect(result.current.anyFeet).toBe(true);
  });

  it('still lets an explicit characteristics array win over the paint', () => {
    forkSeed.frame = { 1: { state: 'STARTING' }, 2: { state: 'FOOT' } };
    createClimb.litUpHoldsMap = forkSeed.frame;
    const { result } = renderHook(() =>
      useCreateClimbScreen({
        board: SPRAY_BOARD,
        forkFrames: 'p1r1p2r4',
        forkName: 'Parent',
        forkCharacteristics: JSON.stringify(['any_feet']),
      }),
    );
    expect(result.current.anyFeet).toBe(true);
  });

  it('leaves a rule-less remix on a catalogue board closed, as before', () => {
    // The paint only answers this question where feet are open by default. A
    // Kilter remix with no marked feet must NOT come back as an any-feet climb.
    forkSeed.frame = { 1: { state: 'STARTING' }, 2: { state: 'FINISH' } };
    createClimb.litUpHoldsMap = forkSeed.frame;
    const { result } = renderHook(() =>
      useCreateClimbScreen({ board: KILTER_BOARD, forkFrames: 'p1r12p2r14', forkName: 'Parent' }),
    );
    expect(result.current.anyFeet).toBe(false);
  });

  it('leaves a catalogue board with its feet closed by default', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));
    expect(result.current.anyFeet).toBe(false);
  });
});

describe('the autosave slot follows the wall version', () => {
  it('re-keys the draft slot when the wall lands after the first render', async () => {
    // A cold spray entry renders before the registry has the wall, so the key
    // folds in `-sv0`. Autosaving into that slot outlives the loader's
    // superseded-draft sweep, which is how a WIP disappears on the next mount.
    // The stubbed key reads `sprayToken`, standing in for the module-level
    // registry the real one reads; the prop is what tells the memo to look again.
    // In production both move together when the wall lands.
    sprayToken.current = '-sv0';
    const { result, rerender } = renderHook(
      ({ token }: { token: string }) => useCreateClimbScreen({ board: SPRAY_BOARD, sprayWallToken: token }),
      { initialProps: { token: '-sv0' } },
    );

    act(() => result.current.setName('Cold open'));
    await waitFor(() => expect(draftStore.saveDraft).toHaveBeenCalled());
    expect(draftStore.saveDraft.mock.calls[0][0]).toContain('-sv0');

    draftStore.saveDraft.mockClear();
    sprayToken.current = '-sv1';
    rerender({ token: '-sv1' });
    act(() => result.current.setName('Wall landed'));
    await waitFor(() => expect(draftStore.saveDraft).toHaveBeenCalled());
    expect(draftStore.saveDraft.mock.calls.at(-1)?.[0]).toContain('-sv1');
  });
});

describe('a remix inherits its parent grade', () => {
  it('opens a remix of a graded wall climb at its parent grade', () => {
    const { result } = renderHook(() =>
      useCreateClimbScreen({
        board: SPRAY_BOARD,
        forkFrames: 'p1r1p2r3',
        forkName: 'Parent',
        forkDifficultyId: SIX_C_DIFFICULTY_ID,
      }),
    );
    expect(result.current.setterGradeDifficultyId).toBe(SIX_C_DIFFICULTY_ID);
    expect(result.current.setterGradeMissing).toBe(false);
  });

  it('opens a remix of an ungraded parent unset rather than at the last-used grade', () => {
    const { result } = renderHook(() =>
      useCreateClimbScreen({ board: SPRAY_BOARD, forkFrames: 'p1r1p2r3', forkName: 'Parent' }),
    );
    expect(result.current.setterGradeDifficultyId).toBeNull();
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

describe('the last-used grade seed', () => {
  it('seeds a fresh climb from the board\u2019s last published grade', async () => {
    await setPreference(lastUsedGradeKey('spray'), SIX_C_DIFFICULTY_ID);
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));
    await waitFor(() => expect(result.current.setterGradeDifficultyId).toBe(SIX_C_DIFFICULTY_ID));
  });

  it('seeds AGAIN for the second climb of a session', async () => {
    // `lastDifficultyId` does not move between the two climbs, so the seed effect
    // never re-runs on its own — the latch has to be released by Start new or the
    // second and every later climb opens with an empty picker.
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => {
      result.current.setName('First of the session');
      result.current.setIsDraft(false);
      result.current.setSetterGradeDifficultyId(SIX_C_DIFFICULTY_ID);
    });
    await act(async () => {
      await result.current.handleSave();
    });
    await waitFor(async () => expect(await getPreference<number>(lastUsedGradeKey('spray'))).toBe(SIX_C_DIFFICULTY_ID));

    await act(async () => {
      result.current.handleNewClimb();
    });

    await waitFor(() => expect(result.current.setterGradeDifficultyId).toBe(SIX_C_DIFFICULTY_ID));
  });

  it('does not let the seed overrule a grade the setter has moved', async () => {
    await setPreference(lastUsedGradeKey('spray'), SIX_C_DIFFICULTY_ID);
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));
    await waitFor(() => expect(result.current.setterGradeDifficultyId).toBe(SIX_C_DIFFICULTY_ID));

    // 7a/V6.
    act(() => result.current.setSetterGradeDifficultyId(22));
    await waitFor(() => expect(result.current.setterGradeDifficultyId).toBe(22));
  });
});

describe('a catalogue board never carries a setter grade', () => {
  it('ignores a fork grade on a board that does not publish with one', () => {
    const { result } = renderHook(() =>
      useCreateClimbScreen({
        board: KILTER_BOARD,
        forkFrames: 'p1r12p2r14',
        forkName: 'Parent',
        forkDifficultyId: SIX_C_DIFFICULTY_ID,
      }),
    );
    expect(result.current.setterGradeDifficultyId).toBeNull();
  });

  it('remembers nothing after a catalogue publish, so later climbs send no grade', async () => {
    const { result } = renderHook(() =>
      useCreateClimbScreen({
        board: KILTER_BOARD,
        forkFrames: 'p1r12p2r14',
        forkName: 'Parent',
        forkDifficultyId: SIX_C_DIFFICULTY_ID,
      }),
    );

    act(() => {
      result.current.setName('Kilter remix');
      result.current.setIsDraft(false);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.saveClimb.mock.calls[0][0].user_grade).toBeUndefined();
    expect(await getPreference<number>(lastUsedGradeKey('kilter'))).toBeNull();
  });
});

describe('an unnameable grade id', () => {
  it('sends no grade rather than an empty string the server rejects', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    // 99 is not on the shared scale, so `getGradeLabel` answers `''`. An empty
    // string passes the server's `userGrade != null` guard and comes back as
    // `"" is not a grade on the Boardsesh scale`.
    act(() => {
      result.current.setName('Off-scale id');
      result.current.setSetterGradeDifficultyId(99);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.saveClimb.mock.calls[0][0].user_grade).toBeUndefined();
  });
});
