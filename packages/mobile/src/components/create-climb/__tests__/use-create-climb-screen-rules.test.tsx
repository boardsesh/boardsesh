// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The climb-RULE half of the create controller: the "any feet" switch, its
// exclusivity with campus, what a save/update actually puts on the wire, and what
// a remix inherits from the climb it was remixed from (#4832).
//
// The real @boardsesh/shared-schema characteristic helpers run here on purpose —
// a hand-rolled copy of that token table is exactly what would let an any_feet
// regression pass.

const ble = vi.hoisted(() => ({
  context: null as null | {
    boardName: string;
    layoutId: number;
    sizeId: number;
    isConnected: boolean;
    loading: boolean;
    sendFramesToBoard: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  },
}));

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
  litUpHoldsMap: { 1: { state: 'STARTING' } } as Record<number, { state: string }>,
  frames: [{ 1: { state: 'STARTING' } }] as Array<Record<number, { state: string }>>,
  frameCount: 1,
  currentFrameIndex: 0,
  setHoldState: vi.fn(),
  generateFramesString: vi.fn(() => 'p1r4p2r2p3r3'),
  currentFrameBleString: vi.fn(() => 'p1r4p2r2p3r3'),
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
  getPaintRoles: () => ['HAND', 'STARTING', 'FINISH', 'FOOT'],
  computeRoleCapacity: () => ({}),
  getNextBrushRole: () => 'HAND',
}));

import { useCreateClimbScreen, parseForkCharacteristics } from '../use-create-climb-screen';

const WOODS_BOARD = { boardName: 'woods' as const, layoutId: 1, sizeId: 2, setIds: '1', angle: 40 };
const KILTER_BOARD = { boardName: 'kilter' as const, layoutId: 8, sizeId: 17, setIds: '26,27', angle: 40 };

beforeEach(() => {
  ble.context = null;
  graphql.climb = undefined;
  graphql.climbFailed = false;
  boardActions.saveClimb.mockReset();
  boardActions.saveClimb.mockResolvedValue({ uuid: 'saved-1', createdAt: null, publishedAt: null, isDraft: true });
  boardActions.updateClimb.mockReset();
  boardActions.updateClimb.mockResolvedValue({ uuid: 'saved-1', createdAt: null, publishedAt: null, isDraft: true });
  queue.setCurrentClimb.mockReset();
  draftStore.loadDraft.mockReset();
  draftStore.loadDraft.mockResolvedValue(null);
  draftStore.saveDraft.mockReset();
  draftStore.saveDraft.mockResolvedValue(undefined);
  createClimb.duplicateFrame.mockClear();
  createClimb.loadFrames.mockClear();
});

describe('parseForkCharacteristics', () => {
  it('keeps an explicitly empty array distinct from an absent param', () => {
    // The whole reason the param is JSON and not a comma list: `[]` (a source
    // whose rules are all defaults) must not read as "we were told nothing".
    expect(parseForkCharacteristics('[]')).toEqual([]);
    expect(parseForkCharacteristics(undefined)).toBeNull();
    expect(parseForkCharacteristics('')).toBeNull();
  });

  it('parses a token list', () => {
    expect(parseForkCharacteristics('["no_match","any_feet"]')).toEqual(['no_match', 'any_feet']);
  });

  it('reads malformed input as absent rather than throwing during render', () => {
    // This runs in a useState initialiser, i.e. DURING RENDER, where a throw is
    // unrecoverable — the #3804 lesson one route over.
    expect(parseForkCharacteristics('not json')).toBeNull();
    expect(parseForkCharacteristics('{"campus":true}')).toBeNull();
  });

  it('drops non-string entries', () => {
    expect(parseForkCharacteristics('["campus",3,null]')).toEqual(['campus']);
  });
});

describe('any feet / campus exclusivity', () => {
  it('starts a new climb with every rule at its default', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD }));
    expect(result.current.anyFeet).toBe(false);
    expect(result.current.campus).toBe(false);
    expect(result.current.noMatch).toBe(false);
    expect(result.current.noKickboard).toBe(false);
  });

  it('turns campus off when any feet goes on', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD }));
    act(() => result.current.setCampus(true));
    act(() => result.current.setAnyFeet(true));
    expect(result.current.anyFeet).toBe(true);
    expect(result.current.campus).toBe(false);
  });

  it('turns any feet off when campus goes on', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD }));
    act(() => result.current.setAnyFeet(true));
    act(() => result.current.setCampus(true));
    expect(result.current.campus).toBe(true);
    expect(result.current.anyFeet).toBe(false);
  });

  it('leaves no-kickboard alone — it answers a different question', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));
    act(() => result.current.setNoKickboard(true));
    act(() => result.current.setAnyFeet(true));
    expect(result.current.noKickboard).toBe(true);
    expect(result.current.anyFeet).toBe(true);
  });

  it('offers the any-feet row by default', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD }));
    expect(result.current.anyFeetAvailable).toBe(true);
  });

  it('withdraws the any-feet row for a climb whose MoonBoard method already forbids feet', async () => {
    // The editor cannot clear a method token, so the row would keep saying "no
    // feet" whatever this switch sent — a climb that contradicts itself.
    graphql.climb = {
      uuid: 'moon-1',
      name: 'Footless problem',
      description: '',
      frames: 'p1r12',
      characteristics: ['method_footless'],
      is_draft: true,
    };
    const { result } = renderHook(() =>
      useCreateClimbScreen({ board: { ...KILTER_BOARD, boardName: 'moonboard' }, editClimbUuid: 'moon-1' }),
    );

    await waitFor(() => expect(result.current.anyFeetAvailable).toBe(false));
    act(() => result.current.setAnyFeet(true));
    await waitFor(() => expect(result.current.anyFeet).toBe(false));
  });
});

describe('rules on the save payload', () => {
  it('sends both booleans and the board size when creating', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD }));

    act(() => result.current.setName('Treat yo self'));
    act(() => {
      result.current.setNoMatch(true);
      result.current.setAnyFeet(true);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.saveClimb).toHaveBeenCalledWith(
      expect.objectContaining({ no_match: true, any_feet: true, size_id: 2, layout_id: 1 }),
    );
  });

  it('keeps any_feet OUT of the legacy characteristics array', async () => {
    // The array is the FULL desired state of the tokens an old client knows, so
    // putting any_feet in it lets one of those clients clear a rule it has never
    // heard of.
    const { result } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD }));

    act(() => result.current.setName('Open feet'));
    act(() => result.current.setAnyFeet(true));
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.saveClimb.mock.calls[0][0].characteristics).toBeNull();
  });

  it('sends explicit false to clear a rule on update, never null', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD }));

    act(() => result.current.setName('Rules off'));
    act(() => result.current.setAnyFeet(true));
    await act(async () => {
      await result.current.handleSave();
    });

    act(() => result.current.setAnyFeet(false));
    await act(async () => {
      await result.current.handleSave();
    });

    // `updateClimb` takes the camelCase GraphQL input directly (no snake_case
    // mapper in between), and omission would PRESERVE the flag rather than clear it.
    expect(boardActions.updateClimb).toHaveBeenCalledWith(
      expect.objectContaining({ anyFeet: false, noMatch: false, sizeId: 2 }),
    );
  });

  it('leaves the Woods description alone instead of prefixing "No match"', async () => {
    // The prefix is an Aurora wire convention. On Woods it would be the setter's
    // prose, silently rewritten.
    const { result } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD }));

    act(() => {
      result.current.setName('Prose');
      result.current.setDescription('Sit start, big move right.');
      result.current.setNoMatch(true);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    const payload = boardActions.saveClimb.mock.calls[0][0];
    expect(payload.description).toBe('Sit start, big move right.');
    expect(payload.no_match).toBe(true);
  });

  it('still encodes the marker into an Aurora climb description', async () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));

    act(() => {
      result.current.setName('Aurora climb');
      result.current.setDescription('Crimpy.');
      result.current.setNoMatch(true);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.saveClimb.mock.calls[0][0].description).toBe('No match\nCrimpy.');
  });
});

describe('the provisional queue row', () => {
  function queuedClimb(): Record<string, unknown> {
    const calls = queue.setCurrentClimb.mock.calls;
    return (calls[calls.length - 1]?.[0] as { climb: Record<string, unknown> }).climb;
  }

  it('carries any_feet so the queue row shows the same rule the editor does', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD }));

    act(() => result.current.setName('Open feet'));
    act(() => result.current.setAnyFeet(true));
    act(() => result.current.handleSetActive());

    expect(queuedClimb().characteristics).toEqual(expect.arrayContaining(['any_feet']));
  });

  it('records a default-rules Woods climb as [] rather than "rules unknown"', () => {
    // On a board that states both rules, null means "nobody recorded them" —
    // which is the one thing the editor definitely knows is false.
    const { result } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD }));

    act(() => result.current.setName('All defaults'));
    act(() => result.current.handleSetActive());

    expect(queuedClimb().characteristics).toEqual([]);
    expect(queuedClimb().compatibleSizeIds).toEqual([2]);
  });

  it('keeps a default-rules Aurora climb at null, as before', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));

    act(() => result.current.setName('All defaults'));
    act(() => result.current.handleSetActive());

    expect(queuedClimb().characteristics).toBeNull();
  });
});

describe('remix seeding (#4832)', () => {
  const forkArgs = {
    board: WOODS_BOARD,
    forkFrames: 'p1r4p2r2',
    forkName: 'Treat yo self',
    forkDescription: 'Sit start.',
  };

  it('inherits every supported rule from the source climb', () => {
    const { result } = renderHook(() =>
      useCreateClimbScreen({
        ...forkArgs,
        forkCharacteristics: JSON.stringify(['no_match', 'any_feet', 'no_kickboard']),
      }),
    );

    expect(result.current.noMatch).toBe(true);
    expect(result.current.anyFeet).toBe(true);
    expect(result.current.noKickboard).toBe(true);
    expect(result.current.campus).toBe(false);
  });

  it('inherits campus without any feet', () => {
    const { result } = renderHook(() =>
      useCreateClimbScreen({ ...forkArgs, forkCharacteristics: JSON.stringify(['campus']) }),
    );

    expect(result.current.campus).toBe(true);
    expect(result.current.anyFeet).toBe(false);
  });

  it('reads an explicitly empty array as all-defaults, not as "look at the description"', () => {
    const { result } = renderHook(() =>
      useCreateClimbScreen({ ...forkArgs, forkDescription: 'No match\nSit start.', forkCharacteristics: '[]' }),
    );

    expect(result.current.noMatch).toBe(false);
    expect(result.current.anyFeet).toBe(false);
  });

  it('falls back to the legacy description prefix only when the array is absent', () => {
    const { result } = renderHook(() =>
      useCreateClimbScreen({ ...forkArgs, board: KILTER_BOARD, forkDescription: 'No match\nSit start.' }),
    );

    expect(result.current.noMatch).toBe(true);
    // ...and the editable description is left clean.
    expect(result.current.description).toBe('Sit start.');
  });

  it('never sniffs the description on a board with no such convention', () => {
    const { result } = renderHook(() =>
      useCreateClimbScreen({ ...forkArgs, forkDescription: 'No match holds on this one, just jugs.' }),
    );

    expect(result.current.noMatch).toBe(false);
  });

  it('carries the inherited rules straight into the save payload', async () => {
    const { result } = renderHook(() =>
      useCreateClimbScreen({ ...forkArgs, forkCharacteristics: JSON.stringify(['no_match', 'any_feet']) }),
    );

    await act(async () => {
      await result.current.handleSave();
    });

    expect(boardActions.saveClimb).toHaveBeenCalledWith(
      expect.objectContaining({ no_match: true, any_feet: true, size_id: 2 }),
    );
  });
});

describe('editing an existing climb', () => {
  it('seeds the rules from the structured flags', async () => {
    graphql.climb = {
      uuid: 'woods-1',
      name: 'Treat yo self',
      description: 'Sit start.',
      frames: 'p1r4',
      characteristics: ['no_match', 'any_feet'],
      is_draft: true,
      compatibleSizeIds: [2],
    };
    const { result } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD, editClimbUuid: 'woods-1' }));

    await waitFor(() => expect(result.current.noMatch).toBe(true));
    expect(result.current.anyFeet).toBe(true);
    expect(result.current.editSizeMismatch).toBe(false);
  });

  it('prefers the structured flags over a description that merely starts with the words', async () => {
    graphql.climb = {
      uuid: 'kilter-1',
      name: 'Prose climb',
      description: 'No match for this one anywhere in the gym.',
      frames: 'p1r12',
      characteristics: [],
      is_draft: true,
    };
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD, editClimbUuid: 'kilter-1' }));

    await waitFor(() => expect(result.current.name).toBe('Prose climb'));
    expect(result.current.noMatch).toBe(false);
  });

  it('falls back to the description only for a row that carries no characteristics at all', async () => {
    graphql.climb = {
      uuid: 'kilter-2',
      name: 'Legacy row',
      description: 'No match\nCrimpy.',
      frames: 'p1r12',
      characteristics: null,
      is_draft: true,
    };
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD, editClimbUuid: 'kilter-2' }));

    await waitFor(() => expect(result.current.noMatch).toBe(true));
  });

  it('refuses to seed a climb set on a different board size', async () => {
    // Woods hold ids are size-relative, so the 8x10's frames "fit" the 12x12 by
    // id and would seed a completely different set of holds — then save them back
    // over the original.
    graphql.climb = {
      uuid: 'woods-8x10',
      name: 'Eight by ten',
      description: '',
      frames: 'p1r4',
      characteristics: [],
      is_draft: true,
      compatibleSizeIds: [1],
    };
    const { result } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD, editClimbUuid: 'woods-8x10' }));

    await waitFor(() => expect(result.current.editSizeMismatch).toBe(true));
    expect(createClimb.loadFrames).not.toHaveBeenCalled();
    expect(result.current.name).toBe('');
  });
});

describe('single-frame boards', () => {
  it('hides the frame controls and refuses to make a second frame on Woods', () => {
    // `getWoodsBluetoothPacket` throws on the comma a second frame introduces, so
    // a two-frame Woods climb would save and then refuse to light the wall.
    const { result } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD }));

    expect(result.current.supportsMultiFrame).toBe(false);
    act(() => result.current.duplicateFrame());
    expect(createClimb.duplicateFrame).not.toHaveBeenCalled();
  });

  it('still duplicates frames on a board that supports them', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: KILTER_BOARD }));

    expect(result.current.supportsMultiFrame).toBe(true);
    act(() => result.current.duplicateFrame());
    expect(createClimb.duplicateFrame).toHaveBeenCalled();
  });
});

describe('Woods preview wall size', () => {
  it.each([1, 2])('only writes frames when connected size %s matches the editor', async (sizeId) => {
    vi.useFakeTimers();
    try {
      const sendFramesToBoard = vi.fn();
      const connect = vi.fn();
      ble.context = {
        boardName: 'woods',
        layoutId: 1,
        sizeId,
        isConnected: true,
        loading: false,
        sendFramesToBoard,
        connect,
        disconnect: vi.fn(),
      };
      const { result, unmount } = renderHook(() => useCreateClimbScreen({ board: WOODS_BOARD }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      if (sizeId === 2) expect(sendFramesToBoard).toHaveBeenCalled();
      else {
        expect(sendFramesToBoard).not.toHaveBeenCalled();
        ble.context.isConnected = false;
        act(() => result.current.handleToggleBle());
        expect(connect).not.toHaveBeenCalled();
      }
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
