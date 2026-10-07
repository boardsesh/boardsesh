// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The spray-wall branch of the create controller (#5443): publishing with no
// grade (#5971), the any-feet default and the FOOT-hold rule that keeps it
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
const queue = vi.hoisted(() => ({ setCurrentClimb: vi.fn(), refreshAuthoredClimb: vi.fn() }));
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
  useQueueActions: () => ({
    setCurrentClimb: queue.setCurrentClimb,
    refreshAuthoredClimb: queue.refreshAuthoredClimb,
  }),
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
import { useCreateClimbScreen, withoutStoredGrade } from '../use-create-climb-screen';

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

function registerWall(angle: number) {
  registerSprayWall(LAYOUT_ID, {
    wallUuid: 'wall-uuid',
    angle,
    version: 1,
    versionId: 1,
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

afterEach(() => {
  clearSprayWallRegistry();
});

describe('publishing a wall climb, with no grade (#5971)', () => {
  it('starts a wall climb on publish, and a catalogue climb on draft', () => {
    // #5954: a draft is left out of the Climbs list, so a wall climb that saved
    // as one looked like a climb that was lost.
    const { result: spray } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));
    const { result: kilter } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));
    expect(spray.current.isDraft).toBe(false);
    expect(kilter.current.isDraft).toBe(true);
  });

  it('says the name is missing on a Save tap with no name, and clears it once typing starts', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));
    expect(result.current.nameMissingHint).toBe(false);

    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.focusNameSignal).toBe(1);
    expect(result.current.nameMissingHint).toBe(true);
    expect(boardActions.saveClimb).not.toHaveBeenCalled();

    act(() => result.current.setName('S'));
    expect(result.current.nameMissingHint).toBe(false);
  });

  it('bumps the hint tick on every blank Save tap, so a repeat tap is announced again', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));
    await act(async () => {
      await result.current.handleSave();
    });
    expect(result.current.nameMissingTick).toBe(1);
    await act(async () => {
      await result.current.handleSave();
    });
    expect(result.current.nameMissingTick).toBe(2);
    expect(result.current.nameMissingHint).toBe(true);
  });

  it('keeps the hint while the name is only whitespace, matching the Save gate', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));
    await act(async () => {
      await result.current.handleSave();
    });
    act(() => result.current.setName('   '));
    expect(result.current.nameMissingHint).toBe(true);
    act(() => result.current.setName('  a '));
    expect(result.current.nameMissingHint).toBe(false);
  });

  it('drops the hint when a new climb starts, even though the name was already blank', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));
    await act(async () => {
      await result.current.handleSave();
    });
    expect(result.current.nameMissingHint).toBe(true);
    await act(async () => {
      result.current.confirmNewClimb();
    });
    await waitFor(() => expect(result.current.nameMissingHint).toBe(false));
  });

  it('still disables Save, and names the holds, while a start or finish is missing', () => {
    createClimb.canPublish = false;
    try {
      const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));
      act(() => result.current.setName('One hold'));

      expect(result.current.publishBlocked).toBe(true);
      expect(result.current.draftStatus?.text).toBe('mobile.create.publish.blocked');
    } finally {
      createClimb.canPublish = true;
    }
  });

  it('keeps the next climb of a session on publish', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => {
      result.current.setName('First of the session');
    });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(boardActions.saveClimb.mock.calls[0][0].is_draft).toBe(false);

    await act(async () => {
      result.current.handleNewClimb();
    });

    await waitFor(() => expect(result.current.name).toBe(''));
    expect(result.current.isDraft).toBe(false);
  });

  it('puts a catalogue board back on draft when a new climb starts', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));

    act(() => result.current.setIsDraft(false));
    await act(async () => {
      result.current.confirmNewClimb();
    });

    await waitFor(() => expect(result.current.isDraft).toBe(true));
  });

  it('publishes with no grade, and sends none: the first ascent grades it', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => result.current.setName('Slopey traverse'));
    expect(result.current.publishBlocked).toBe(false);
    expect(result.current.draftStatus?.text).not.toBe('mobile.create.publish.blocked');

    await act(async () => {
      await result.current.handleSave();
    });

    const payload = boardActions.saveClimb.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.is_draft).toBe(false);
    expect(payload).not.toHaveProperty('user_grade');
  });

  it('leaves a DRAFT saveable with no grade', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => {
      result.current.setName('Work in progress');
      result.current.setIsDraft(true);
    });
    expect(result.current.publishBlocked).toBe(false);

    await act(async () => {
      await result.current.handleSave();
    });

    const payload = boardActions.saveClimb.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.is_draft).toBe(true);
    expect(payload.user_grade).toBeUndefined();
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
    // folds in `-svid0`. Autosaving into that slot outlives the loader's
    // superseded-draft sweep, which is how a WIP disappears on the next mount.
    // The stubbed key reads `sprayToken`, standing in for the module-level
    // registry the real one reads; the prop is what tells the memo to look again.
    // In production both move together when the wall lands.
    sprayToken.current = '-svid0';
    const { result, rerender } = renderHook(
      ({ token }: { token: string }) => useCreateClimbScreen({ board: SPRAY_BOARD, sprayWallToken: token }),
      { initialProps: { token: '-svid0' } },
    );

    act(() => result.current.setName('Cold open'));
    await waitFor(() => expect(draftStore.saveDraft).toHaveBeenCalled());
    expect(draftStore.saveDraft.mock.calls[0][0]).toContain('-svid0');

    draftStore.saveDraft.mockClear();
    sprayToken.current = '-svid1';
    rerender({ token: '-svid1' });
    act(() => result.current.setName('Wall landed'));
    await waitFor(() => expect(draftStore.saveDraft).toHaveBeenCalled());
    expect(draftStore.saveDraft.mock.calls.at(-1)?.[0]).toContain('-svid1');
  });
});

describe('the wall owns the angle and the identity', () => {
  it('publishes at the wall angle, not at the route param', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => {
      result.current.setName('At the wall angle');
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.saveClimb.mock.calls[0][0].angle).toBe(25);
  });

  it('presents the wall uuid on every spray write', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => {
      result.current.setName('Share-link crew');
      result.current.setIsDraft(true);
    });
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

describe('the queue item after a save', () => {
  // `syncSavedToQueue` runs in the same tick as `setSavedClimb`, so anything it
  // reads off the `savedClimb` STATE is still the previous render's — null on a
  // first save. The play drawer's Draft badge and its Edit gate both read this.
  it('queues a first publish as published, not as a draft', async () => {
    boardActions.saveClimb.mockResolvedValue({
      uuid: 'saved-1',
      createdAt: '2026-10-03T10:00:00.000Z',
      publishedAt: '2026-10-03T10:00:00.000Z',
      isDraft: false,
    });
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    act(() => {
      result.current.setName('Straight to the wall');
    });
    await act(async () => {
      await result.current.handleSave();
    });

    const queued = queue.setCurrentClimb.mock.calls.at(-1)?.[0] as { climb: Record<string, unknown> };
    expect(queued.climb.uuid).toBe('saved-1');
    expect(queued.climb.is_draft).toBe(false);
    expect(queued.climb.published_at).toBe('2026-10-03T10:00:00.000Z');
  });

  it('queues a first draft save as a draft', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));

    act(() => result.current.setName('Still working on it'));
    await act(async () => {
      await result.current.handleSave();
    });

    const queued = queue.setCurrentClimb.mock.calls.at(-1)?.[0] as { climb: Record<string, unknown> };
    expect(queued.climb.is_draft).toBe(true);
  });
});

// `defaultIsDraft` is only where the switch STARTS on a fresh climb. Work that
// already has an answer keeps it (#5954): a phone copy from before the change
// was a draft and must restore as one, and an edit takes the row's own state.
describe('the publish default never overrules a climb that already has an answer', () => {
  const storedSlot = (isDraft: boolean) => ({
    holdsJson: '{}',
    framesJson: '[{}]',
    name: 'Left half-finished',
    description: '',
    isDraft,
  });
  const serverRow = (isDraft: boolean) => ({
    uuid: 'climb-9',
    name: 'On the server',
    description: '',
    frames: 'p1r1p2r3',
    is_draft: isDraft,
    created_at: null,
    published_at: isDraft ? null : '2026-10-01T10:00:00.000Z',
  });

  it('restores a phone copy saved as a draft as a draft', async () => {
    draftStore.loadDraft.mockResolvedValue(storedSlot(true));
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    await waitFor(() => expect(result.current.name).toBe('Left half-finished'));
    expect(result.current.isDraft).toBe(true);
  });

  it('restores a phone copy saved for publishing as publish', async () => {
    draftStore.loadDraft.mockResolvedValue(storedSlot(false));
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD }));

    await waitFor(() => expect(result.current.name).toBe('Left half-finished'));
    expect(result.current.isDraft).toBe(false);
  });

  it('opens a server draft for editing as a draft', async () => {
    graphql.climb = serverRow(true);
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD, editClimbUuid: 'climb-9' }));

    await waitFor(() => expect(result.current.name).toBe('On the server'));
    expect(result.current.isDraft).toBe(true);
  });

  it('opens a published climb for editing as published', async () => {
    graphql.climb = serverRow(false);
    const { result } = renderHook(() => useCreateClimbScreen({ board: SPRAY_BOARD, editClimbUuid: 'climb-9' }));

    await waitFor(() => expect(result.current.name).toBe('On the server'));
    expect(result.current.isDraft).toBe(false);
  });

  it('opens a published Kilter climb for editing as published too, over the draft default', async () => {
    graphql.climb = { ...serverRow(false), frames: 'p1r12p2r14' };
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD, editClimbUuid: 'climb-9' }));

    await waitFor(() => expect(result.current.name).toBe('On the server'));
    expect(result.current.isDraft).toBe(false);
  });
});

describe('a draft saved with a setter grade by an older build (#5971)', () => {
  it('drops the stored grade from its signature, so it does not read as edited', () => {
    expect(withoutStoredGrade('holds\u0000frames\u0000Name\u00000\u0000grade:20')).toBe(
      'holds\u0000frames\u0000Name\u00000',
    );
    expect(withoutStoredGrade('holds\u0000frames\u0000pace:400\u0000grade:20')).toBe('holds\u0000frames\u0000pace:400');
  });

  it('leaves a signature with no grade, or none at all, alone', () => {
    expect(withoutStoredGrade('holds\u0000frames\u0000Name')).toBe('holds\u0000frames\u0000Name');
    expect(withoutStoredGrade(undefined)).toBeUndefined();
  });
});
