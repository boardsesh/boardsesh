// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Guards the board identity a freshly created climb carries into the queue.
//
// `buildProvisionalClimb` used to omit boardType/layoutId, so a just-saved climb — a
// remix, typically — round-tripped BOARD-LESS to party peers via `toClimbInput` and
// into the board-presence report.
//
// The important part of this file: it runs the REAL `climbToQueueItem`. Every other
// create-screen test mocks it as a pass-through, which would let this suite pass on a
// provisional climb whose fields never actually survive the queue boundary. Mock it
// here and these assertions prove nothing about what a peer receives.

const cryptoMock = vi.hoisted(() => {
  let counter = 0;
  return { randomUUID: vi.fn(() => `uuid-${++counter}`) };
});

const board = vi.hoisted(() => ({
  isAuthenticated: true,
  saveClimb: vi.fn(),
  updateClimb: vi.fn(),
  isDuplicateClimbError: vi.fn((_err: unknown) => false),
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const queue = vi.hoisted(() => ({ setCurrentClimb: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn() }));

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

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: cryptoMock.randomUUID }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
// Partial: the controller now reads @boardsesh/board-config too, which imports
// this package for real (SUPPORTED_BOARDS). A total mock breaks that import.
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
    isAuthenticated: board.isAuthenticated,
    saveClimb: board.saveClimb,
    updateClimb: board.updateClimb,
  }),
  isDuplicateClimbError: (err: unknown) => board.isDuplicateClimbError(err),
}));
vi.mock('@boardsesh/graphql-client', () => ({
  GraphQLOperationError: class GraphQLOperationError extends Error {},
}));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ refreshAuthState: vi.fn() }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'user-1', displayName: 'Tester' } }),
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
// NOTE: ../../../lib/climb-to-queue-item is deliberately NOT mocked — see the header.
vi.mock('../../../lib/create-climb-draft-store', () => ({
  loadDraft: vi.fn(async () => null),
  saveDraft: vi.fn(async () => {}),
  clearDraft: vi.fn(async () => {}),
  createClimbDraftKey: () => 'draft-key',
  createClimbEditDraftKey: (boardType: string, uuid: string) => `edit:${boardType}:${uuid}`,
  createClimbForkDraftKey: (boardKey: string) => `fork:${boardKey}`,
  isDraftStorageAvailable: () => true,
}));
// The controller awaits `confirm` from here for "start a new climb"; the real
// provider pulls in react-native's Alert/Platform, which this file doesn't stub.
vi.mock('../../../providers/dialog-provider', () => ({
  useConfirm: () => vi.fn(async () => true),
}));
vi.mock('../brush-roles', () => ({
  getPaintRoles: () => ['HAND', 'STARTING', 'FINISH'],
}));

import type { Climb, ClimbQueueItem } from '@boardsesh/queue';
import { climbToQueueItem, toClimbInput } from '../../../lib/climb-to-queue-item';
import { useCreateClimbScreen } from '../use-create-climb-screen';

const kilterBoard = { boardName: 'kilter' as const, layoutId: 8, sizeId: 17, setIds: '26,27', angle: 40 };

/** The queue item handed to setCurrentClimb by the last Set Active / save sync. */
function lastQueuedItem(): ClimbQueueItem {
  const calls = queue.setCurrentClimb.mock.calls;
  return calls[calls.length - 1]?.[0] as ClimbQueueItem;
}

beforeEach(() => {
  toast.showToast.mockClear();
  queue.setCurrentClimb.mockClear();
  router.push.mockClear();
  cryptoMock.randomUUID.mockClear();
  board.isAuthenticated = true;
  board.isDuplicateClimbError.mockReturnValue(false);
  board.saveClimb.mockReset();
  board.updateClimb.mockReset();
});

describe('create-climb queue hand-off carries board identity', () => {
  it('Set Active queues the WIP with the create board, through the real climbToQueueItem', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setName('Sloper Traverse remix'));
    act(() => result.current.handleSetActive());

    const { climb } = lastQueuedItem();
    // The whole point: a board-less climb is one a peer can't place and the presence
    // report can't attribute.
    expect(climb.boardType).toBe('kilter');
    expect(climb.layoutId).toBe(8);
    expect(climb.angle).toBe(40);
    expect(climb.name).toBe('Sloper Traverse remix');
    expect(climb.frames).toBe('p1r12p2r13p3r14');
  });

  it('carries the setter and the no-match flag through the real boundary', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setName('Draft Project'));
    act(() => result.current.setNoMatch(true));
    act(() => result.current.handleSetActive());

    const { climb } = lastQueuedItem();
    expect(climb.setter_username).toBe('Tester');
    expect(climb.is_no_match).toBe(true);
  });

  it('survives toClimbInput with its board identity intact (the party-peer wire shape)', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setName('Wire Test'));
    act(() => result.current.handleSetActive());

    const input = toClimbInput(lastQueuedItem().climb);
    expect(input.boardType).toBe('kilter');
    expect(input.layoutId).toBe(8);
  });

  it('keeps the board identity after a save syncs the server uuid into the queue', async () => {
    board.saveClimb.mockResolvedValue({ uuid: 'saved-1', createdAt: null, publishedAt: null, isDraft: true });
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setName('Published Remix'));
    await act(async () => {
      await result.current.handleSave();
    });

    const { climb } = lastQueuedItem();
    expect(climb.uuid).toBe('saved-1');
    expect(climb.boardType).toBe('kilter');
    expect(climb.layoutId).toBe(8);
  });

  it('sends both toggled characteristics to saveClimb, and null when neither is set', async () => {
    board.saveClimb.mockResolvedValue({ uuid: 'saved-2', createdAt: null, publishedAt: null, isDraft: true });
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setName('Both Toggles'));
    act(() => {
      result.current.setNoKickboard(true);
      result.current.setCampus(true);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    const sentCharacteristics = board.saveClimb.mock.calls[0]?.[0]?.characteristics as string[];
    expect(sentCharacteristics).toHaveLength(2);
    expect(sentCharacteristics).toEqual(expect.arrayContaining(['no_kickboard', 'campus']));

    board.saveClimb.mockClear();
    act(() => {
      result.current.setNoKickboard(false);
      result.current.setCampus(false);
    });
    // Re-save as a fresh (unsaved) climb is not exercised here — this hook instance
    // already has a savedClimb row, so the next save goes through updateClimb.
    board.updateClimb.mockResolvedValue({ uuid: 'saved-2', createdAt: null, publishedAt: null, isDraft: true });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(board.updateClimb).toHaveBeenCalledWith(expect.objectContaining({ characteristics: null }));
  });

  it('carries the campus characteristic through the real boundary', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setName('Campus Only'));
    act(() => result.current.setCampus(true));
    act(() => result.current.handleSetActive());

    const { climb } = lastQueuedItem();
    expect(climb.characteristics).toContain('campus');
  });

  it('keeps the no-match badge alongside campus/no-kickboard in the provisional queue row', () => {
    // Regression: ClimbAttributeIcons prefers `characteristics` over `is_no_match`
    // the moment the array is non-null, so a provisional climb that only put
    // campus/no_kickboard into that array (and left no_match to the separate
    // is_no_match bool) would silently drop the no-match badge from the queue.
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setName('No Match Campus'));
    act(() => {
      result.current.setNoMatch(true);
      result.current.setCampus(true);
    });
    act(() => result.current.handleSetActive());

    const { climb } = lastQueuedItem();
    expect(climb.is_no_match).toBe(true);
    expect(climb.characteristics).toEqual(expect.arrayContaining(['no_match', 'campus']));
  });

  it('marks the provisional climb single-frame so playback does not wait on a pace', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setName('Single Frame'));
    act(() => result.current.handleSetActive());

    const { climb } = lastQueuedItem();
    expect(climb.framesCount).toBe(1);
    expect(climb.framesPace).toBeNull();
  });
});

describe('climbToQueueItem board identity at the queue boundary', () => {
  const peerClimb = {
    uuid: 'climb-1',
    boardType: 'tension',
    layoutId: 9,
    name: 'Peer Climb',
    frames: 'p1r12',
    setter_username: 'Someone',
    userId: 'user-2',
    description: 'crimpy',
    mirrored: true,
    is_draft: false,
    published_at: '2026-07-01T00:00:00Z',
    angle: 40,
    ascensionist_count: 3,
    difficulty: 'V5',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  } as unknown as Climb;

  it('forwards the board a climb belongs to', () => {
    const { climb } = climbToQueueItem(peerClimb);
    expect(climb.boardType).toBe('tension');
    expect(climb.layoutId).toBe(9);
  });

  // #3927 landed. Both subscription selection sets (SUBSCRIPTION_CLIMB_FIELDS and
  // the shared CLIMB_FIELDS) now select these, so a peer's rebuild agrees with the
  // creator's copy and no full-queue write pushes a gap back.
  //
  // Do NOT narrow this again without also narrowing both selection sets and
  // `toClimbInput` in the same change. Carrying a field on the write path while a
  // peer's read path omits it makes the field FLAP — it appears, then a peer's
  // setQueue clears it for everyone — which is worse than consistently missing.
  it('carries ownership / draft state so peers can gate Edit locally', () => {
    const { climb } = climbToQueueItem(peerClimb);
    expect(climb).toMatchObject({
      userId: 'user-2',
      description: 'crimpy',
      mirrored: true,
      is_draft: false,
      published_at: '2026-07-01T00:00:00Z',
    });
  });
});
