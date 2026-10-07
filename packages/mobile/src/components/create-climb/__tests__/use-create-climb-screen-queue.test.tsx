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
const cache = vi.hoisted(() => ({ invalidateQueries: vi.fn() }));
const draftStore = vi.hoisted(() => ({ clearDraft: vi.fn(async () => {}) }));
/** The climb `useClimb` answers with when the editor is opened on an existing one. */
const edit = vi.hoisted(() => ({ climb: undefined as Record<string, unknown> | undefined }));
const queue = vi.hoisted(() => ({ setCurrentClimb: vi.fn(), refreshAuthoredClimb: vi.fn() }));
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
  useQueryClient: () => ({ invalidateQueries: cache.invalidateQueries }),
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
  useClimb: () => ({ data: edit.climb }),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({
    setCurrentClimb: queue.setCurrentClimb,
    refreshAuthoredClimb: queue.refreshAuthoredClimb,
  }),
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
  clearDraft: draftStore.clearDraft,
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

import {
  initialState,
  queueReducer,
  type Climb,
  type ClimbAuthoredPatch,
  type ClimbQueueItem,
  type QueueState,
} from '@boardsesh/queue';
import { DEFAULT_PACE_MS } from '@boardsesh/playback-react';
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
  queue.setCurrentClimb.mockReset();
  queue.refreshAuthoredClimb.mockReset();
  router.push.mockClear();
  cryptoMock.randomUUID.mockClear();
  board.isAuthenticated = true;
  board.isDuplicateClimbError.mockReturnValue(false);
  board.saveClimb.mockReset();
  board.updateClimb.mockReset();
  createClimb.frameCount = 1;
  edit.climb = undefined;
  cache.invalidateQueries.mockClear();
  draftStore.clearDraft.mockClear();
  createClimb.generateFramesString.mockReturnValue('p1r12p2r13p3r14');
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

// The creator wrote `frames_pace: 0` on every save, so a published route always
// played at the 750ms default however the setter set the transport — the speed
// control authored nothing. These pin the value actually reaching the wire.
describe('editing a climb somebody else set (#5955)', () => {
  // A wall owner fixing a start hold has not taken the climb. The server never
  // rewrites `user_id` / `setter_username` on an update, so the queue row the
  // editor builds must not either: with the saver's id on it, the play drawer
  // would credit the wall owner and offer the real setter nothing.
  const someoneElsesClimb = {
    uuid: 'climb-9',
    name: 'Left Arete',
    frames: 'p1r12p2r13p3r14',
    description: '',
    difficulty: null,
    userId: 'setter-1',
    setter_username: 'Original Setter',
    is_draft: false,
    published_at: '2020-01-01T00:00:00.000Z',
    created_at: '2020-01-01T00:00:00.000Z',
  };

  it('queues the edited climb under its original setter, not the editor', () => {
    edit.climb = someoneElsesClimb;
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard, editClimbUuid: 'climb-9' }));

    act(() => result.current.handleSetActive());

    const { climb } = lastQueuedItem();
    expect(climb.userId).toBe('setter-1');
    expect(climb.setter_username).toBe('Original Setter');
  });

  it('keeps the original setter on the row a save syncs into the queue', async () => {
    edit.climb = someoneElsesClimb;
    board.updateClimb.mockResolvedValue({
      uuid: 'climb-9',
      createdAt: '2020-01-01T00:00:00.000Z',
      publishedAt: '2020-01-01T00:00:00.000Z',
      isDraft: false,
    });
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard, editClimbUuid: 'climb-9' }));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(board.updateClimb).toHaveBeenCalledTimes(1);
    expect(board.saveClimb).not.toHaveBeenCalled();
    const { climb } = lastQueuedItem();
    expect(climb.uuid).toBe('climb-9');
    expect(climb.userId).toBe('setter-1');
    expect(climb.setter_username).toBe('Original Setter');
  });

  it("says in the climber's language that a spray edit was not allowed", async () => {
    // The client gate ran on a stale read of who can edit the wall. Nothing is
    // lost and the reason is on screen, translated. The server's own sentence
    // is never shown.
    // A spray climb publishes with its setter's grade, so the edit carries one.
    edit.climb = { ...someoneElsesClimb, difficulty: '6a/V3' };
    board.updateClimb.mockRejectedValue({
      response: {
        errors: [{ message: 'You can only update your own climbs', extensions: { code: 'CLIMB_EDIT_NOT_ALLOWED' } }],
      },
    });
    const sprayBoard = { boardName: 'spray' as const, layoutId: 4200, sizeId: 4200, setIds: '1', angle: 40 };
    const { result } = renderHook(() => useCreateClimbScreen({ board: sprayBoard, editClimbUuid: 'climb-9' }));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(toast.showToast).toHaveBeenCalledTimes(1);
    expect(toast.showToast).toHaveBeenCalledWith('createClimbForm.alerts.editNotAllowed', 'error');
    expect(draftStore.clearDraft).not.toHaveBeenCalled();
  });

  it.each([
    ['CLIMB_EDIT_WINDOW_EXPIRED', 'createClimbForm.alerts.editWindowExpired'],
    ['CLIMB_NOT_EDITABLE', 'createClimbForm.alerts.editNotEditable'],
  ])('translates %s on a catalogue board', async (code, key) => {
    edit.climb = someoneElsesClimb;
    board.updateClimb.mockRejectedValue({ extensions: { code }, message: 'server prose' });
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard, editClimbUuid: 'climb-9' }));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(toast.showToast).toHaveBeenCalledWith(key, 'error');
  });

  it('never shows server prose: a failure with no known code gets the generic line, on spray too', async () => {
    edit.climb = { ...someoneElsesClimb, difficulty: '6a/V3' };
    board.updateClimb.mockRejectedValue({
      response: { errors: [{ message: 'Some new refusal', extensions: { code: 'SOMETHING_NEWER' } }] },
    });
    const sprayBoard = { boardName: 'spray' as const, layoutId: 4200, sizeId: 4200, setIds: '1', angle: 40 };
    const { result } = renderHook(() => useCreateClimbScreen({ board: sprayBoard, editClimbUuid: 'climb-9' }));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(toast.showToast).toHaveBeenCalledWith('createClimbForm.alerts.saveFailedFallback', 'error');
  });

  it('says somebody else changed the climb when the server reports an edit conflict', async () => {
    // Two editors, one climb: the save was decided on a row the other edit has
    // replaced. One translated line, no second attempt, and the work stays put.
    edit.climb = { ...someoneElsesClimb, difficulty: '6a/V3' };
    board.updateClimb.mockRejectedValue({
      extensions: { code: 'CLIMB_EDIT_CONFLICT' },
      message: 'This climb changed while you were editing it. Reload it and try again.',
    });
    const sprayBoard = { boardName: 'spray' as const, layoutId: 4200, sizeId: 4200, setIds: '1', angle: 40 };
    const { result } = renderHook(() => useCreateClimbScreen({ board: sprayBoard, editClimbUuid: 'climb-9' }));
    act(() => result.current.setName('Left Arete, fixed'));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(toast.showToast).toHaveBeenCalledTimes(1);
    expect(toast.showToast).toHaveBeenCalledWith('createClimbForm.alerts.editConflict', 'error');
    expect(board.updateClimb).toHaveBeenCalledTimes(1);
    expect(board.saveClimb).not.toHaveBeenCalled();
    expect(queue.setCurrentClimb).not.toHaveBeenCalled();
    // The working copy is still what the climber typed.
    expect(result.current.name).toBe('Left Arete, fixed');
    expect(draftStore.clearDraft).not.toHaveBeenCalled();
  });

  it('recognises the conflict code on a raw GraphQL response too, on any board', async () => {
    edit.climb = someoneElsesClimb;
    board.updateClimb.mockRejectedValue({
      response: { errors: [{ message: 'changed', extensions: { code: 'CLIMB_EDIT_CONFLICT' } }] },
    });
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard, editClimbUuid: 'climb-9' }));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(toast.showToast).toHaveBeenCalledWith('createClimbForm.alerts.editConflict', 'error');
  });

  it('keeps the generic failure line for a refusal from a server that predates the codes', async () => {
    edit.climb = someoneElsesClimb;
    board.updateClimb.mockRejectedValue({ response: { errors: [{ message: 'The 24 hour edit window has expired' }] } });
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard, editClimbUuid: 'climb-9' }));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(toast.showToast).toHaveBeenCalledWith('createClimbForm.alerts.saveFailedFallback', 'error');
  });

  it('still gives a brand-new climb to the climber making it', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.handleSetActive());

    expect(lastQueuedItem().climb.userId).toBe('user-1');
  });
});

describe('authored pace reaches the queue and the server', () => {
  it('publishes the pace the setter dialled on a route', async () => {
    createClimb.frameCount = 3;
    board.saveClimb.mockResolvedValue({ uuid: 'route-1', createdAt: null, publishedAt: null, isDraft: true });
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setName('Paced Route'));
    act(() => result.current.setFramesPace(2000));
    await act(async () => {
      await result.current.handleSave();
    });

    expect(board.saveClimb).toHaveBeenCalledTimes(1);
    expect(board.saveClimb.mock.calls[0][0]).toMatchObject({ frames_count: 3, frames_pace: 2000 });
  });

  it('clamps an out-of-range pace rather than publishing it', () => {
    createClimb.frameCount = 2;
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setFramesPace(120_000));
    expect(result.current.framesPaceMs).toBe(60_000);

    act(() => result.current.setFramesPace(10));
    expect(result.current.framesPaceMs).toBe(300);
  });

  it('lets a setter author the slow paces the catalogue is full of', () => {
    // Roughly half of all synced multi-frame routes are paced slower than 10s a
    // frame — endurance laps, not animation. The ceiling used to sit at 10s, so
    // a setter could not author one and re-saving a synced one sped it up.
    createClimb.frameCount = 2;
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setFramesPace(20_000));
    expect(result.current.framesPaceMs).toBe(20_000);

    act(() => result.current.setFramesPace(60_000));
    expect(result.current.framesPaceMs).toBe(60_000);
  });

  it('publishes no pace on a boulder, whatever the control last held', async () => {
    // Load-bearing rather than tidiness: `assertWoodsSingleFrame` rejects a
    // non-zero pace outright, so a single-frame climb carrying one fails the
    // mutation on Woods. A boulder has no gap between frames to pace anyway.
    board.saveClimb.mockResolvedValue({ uuid: 'boulder-1', createdAt: null, publishedAt: null, isDraft: true });
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setName('Just A Boulder'));
    act(() => result.current.setFramesPace(2000));
    await act(async () => {
      await result.current.handleSave();
    });

    expect(board.saveClimb.mock.calls[0][0]).toMatchObject({ frames_count: 1, frames_pace: 0 });
  });

  it('does not let a boulder look edited over a pace it will never publish', () => {
    // The pace signs into the payload signature, which is what decides whether
    // the draft reads "unsynced edits". A boulder writes `frames_pace: 0`
    // whatever the control last held, so signing the raw control value would
    // make two byte-identical boulders look like different payloads.
    createClimb.frameCount = 1;
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    const before = result.current.draftStatus;
    act(() => result.current.setFramesPace(2000));
    expect(result.current.framesPaceMs).toBe(2000);
    expect(result.current.draftStatus).toEqual(before);
  });

  it('plays the preview at the authored pace, so the transport is honest', () => {
    createClimb.frameCount = 2;
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setFramesPace(1500));
    expect(result.current.playback.paceMs).toBe(1500);
  });
});

// Route mode is an explicit state now, not something inferred from frame count.
// It decides whether the board pays for route chrome at all, which is the whole
// reason #5189 exists.
describe('route mode', () => {
  it('starts a fresh climb as a boulder showing no route chrome', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    expect(result.current.routeMode).toBe(false);
    expect(result.current.showRouteTransport).toBe(false);
  });

  it('shows the transport from the first frame once route mode is on', () => {
    // The point of an explicit mode: the control that makes frame 2 has to be on
    // screen BEFORE frame 2 exists, or the feature is only discoverable to
    // someone who already knows it is there.
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.enterRouteMode());
    expect(result.current.showRouteTransport).toBe(true);
    expect(result.current.frameCount).toBe(1);
  });

  it('lets a one-frame route go back to being a boulder', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.enterRouteMode());
    expect(result.current.canLeaveRouteMode).toBe(true);
    act(() => result.current.leaveRouteMode());
    expect(result.current.showRouteTransport).toBe(false);
  });

  it('refuses to leave route mode while frames would be destroyed', () => {
    // Frames are absolute snapshots, so there is no lossless answer here: keeping
    // frame 1 discards every hold painted after the start position. The setter
    // deletes frames down to one instead, which is undoable.
    createClimb.frameCount = 4;
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.enterRouteMode());
    expect(result.current.canLeaveRouteMode).toBe(false);
    act(() => result.current.leaveRouteMode());
    expect(result.current.showRouteTransport).toBe(true);
  });

  it('never enters route mode on a board that can only hold one frame', () => {
    // Woods: a second frame puts a comma in the frames string, which its packet
    // builder rejects outright.
    const { result } = renderHook(() =>
      useCreateClimbScreen({ board: { ...kilterBoard, boardName: 'woods' as const } }),
    );

    act(() => result.current.enterRouteMode());
    expect(result.current.routeMode).toBe(false);
    expect(result.current.showRouteTransport).toBe(false);
  });

  it('hands back a boulder when you start a new climb from a route', async () => {
    // Every other authoring field resets here; these two have to as well, or the
    // next climb opens wearing route chrome nobody asked for — the exact thing
    // this issue exists to stop, one climb later.
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.enterRouteMode());
    act(() => result.current.setFramesPace(2000));
    expect(result.current.showRouteTransport).toBe(true);

    act(() => result.current.handleNewClimb());
    await act(async () => {
      await result.current.confirmNewClimb();
    });

    expect(result.current.routeMode).toBe(false);
    expect(result.current.showRouteTransport).toBe(false);
    expect(result.current.framesPaceMs).toBe(DEFAULT_PACE_MS);
  });

  it('treats an already-multi-frame climb as a route without being told', () => {
    createClimb.frameCount = 3;
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    expect(result.current.showRouteTransport).toBe(true);
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

// A climb saved twice. `setCurrentClimb` reaches the reducer as a LOCAL
// DELTA_UPDATE_CURRENT_CLIMB, whose same-uuid branch deliberately keeps the item
// it already has, and whose add is skipped for a slot already in the queue. So
// the second save used to leave the first save's copy in place — and with it the
// Draft chip on a climb that had just gone public (#5954 review).
//
// Runs the REAL queue reducer, driven the way the provider drives it. A mocked
// `setCurrentClimb` cannot see this bug: it records the fresh item it was handed,
// which is exactly the item the reducer throws away.
describe('a re-saved climb is refreshed in the queue', () => {
  let queueState: QueueState;
  let correlationCounter = 0;

  beforeEach(() => {
    queueState = initialState({});
    correlationCounter = 0;
    // What the provider's setCurrentClimb dispatches (see dispatchSetCurrent).
    queue.setCurrentClimb.mockImplementation((item: ClimbQueueItem) => {
      queueState = queueReducer(queueState, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item,
          shouldAddToQueue: true,
          insertAfterCurrent: true,
          isServerEvent: false,
          correlationId: `corr-${++correlationCounter}`,
        },
      });
    });
    queue.refreshAuthoredClimb.mockImplementation((climbUuid: string, patch: ClimbAuthoredPatch) => {
      queueState = queueReducer(queueState, { type: 'REFRESH_AUTHORED_CLIMB', payload: { climbUuid, patch } });
    });
    board.saveClimb.mockResolvedValue({ uuid: 'saved-1', createdAt: null, publishedAt: null, isDraft: true });
    board.updateClimb.mockResolvedValue({
      uuid: 'saved-1',
      createdAt: null,
      publishedAt: '2026-10-03T10:00:00.000Z',
      isDraft: false,
    });
  });

  async function saveDraftThenPublish(betweenSaves: () => void = () => {}) {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    act(() => result.current.setName('Slab problem'));
    await act(async () => {
      await result.current.handleSave();
    });
    expect(queueState.currentClimbQueueItem?.climb.is_draft).toBe(true);

    betweenSaves();

    act(() => {
      result.current.setName('Slab problem, final');
      result.current.setIsDraft(false);
    });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(board.updateClimb).toHaveBeenCalledTimes(1);
  }

  it('drops the draft state from the current item and its slot when the draft is current', async () => {
    await saveDraftThenPublish();

    expect(queueState.currentClimbQueueItem?.climb).toMatchObject({
      uuid: 'saved-1',
      name: 'Slab problem, final',
      is_draft: false,
      published_at: '2026-10-03T10:00:00.000Z',
    });
    expect(queueState.queue).toHaveLength(1);
    expect(queueState.queue[0].climb).toMatchObject({ name: 'Slab problem, final', is_draft: false });
  });

  it('drops it from the queue slot too when the draft is queued but not current', async () => {
    const somethingElse = climbToQueueItem(
      { uuid: 'other-climb', name: 'Warm up', frames: 'p9r12', angle: 40 } as Climb,
      { uuid: 'other-slot' },
    );

    await saveDraftThenPublish(() => {
      // The climber moved on to another climb between the two saves.
      queue.setCurrentClimb(somethingElse);
      expect(queueState.currentClimbQueueItem?.uuid).toBe('other-slot');
      expect(queueState.queue.map((item) => item.climb.uuid)).toContain('saved-1');
    });

    // The publish makes it current again, and no stale copy is left behind it.
    expect(queueState.currentClimbQueueItem?.climb).toMatchObject({ uuid: 'saved-1', is_draft: false });
    const copies = queueState.queue.filter((item) => item.climb.uuid === 'saved-1');
    expect(copies).toHaveLength(1);
    expect(copies[0].climb).toMatchObject({
      name: 'Slab problem, final',
      is_draft: false,
      published_at: '2026-10-03T10:00:00.000Z',
    });
  });

  it('seeds the echo-suppression id for the re-save, as a re-assert of the current climb always has', async () => {
    await saveDraftThenPublish();
    // One id per setCurrentClimb. The second came through the same-uuid branch.
    expect(queueState.pendingCurrentClimbUpdates).toEqual(['corr-1', 'corr-2']);
  });
});

// #6023. After the editor has touched a climb, the queue item must carry no
// version: the item's holds are what the editor holds, which no saved version
// may hold, and the sent marks compare the item's holds version with ticks.
//
// It runs through the REAL queue reducer. An earlier version of these tests
// asserted on the item handed to a mocked `setCurrentClimb`, and passed on an
// item the reducer throws away: a local set-current for the uuid that is
// already current is a no-op, so the second save's item never reaches the
// queue. What does reach it is the refresh that follows every save, which
// patches the authored fields (the holds included) and no version.
describe('create-climb queue hand-off: no version on the queued climb (#6023)', () => {
  const FIRST_SAVE_FRAMES = 'p1r12p2r13p3r14';
  const SECOND_SAVE_FRAMES = 'p1r12p2r13p9r14';
  const WIP_FRAMES = 'p1r12p2r13p7r14';

  let queueState: QueueState<Record<string, never>>;
  let correlationCounter = 0;

  beforeEach(() => {
    queueState = initialState({});
    correlationCounter = 0;
    // The same action `dispatchSetCurrent` in queue-provider.tsx dispatches for
    // `setCurrentClimb(item)`: a local update, added to the queue, with a
    // correlation id.
    queue.setCurrentClimb.mockImplementation((item: ClimbQueueItem) => {
      correlationCounter += 1;
      queueState = queueReducer(queueState, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item,
          shouldAddToQueue: true,
          isServerEvent: false,
          correlationId: `correlation-${correlationCounter}`,
          insertAfterCurrent: true,
          pruneSuggestedAfterCurrent: true,
        },
      });
    });
    // And the action `refreshAuthoredClimb` dispatches after it.
    queue.refreshAuthoredClimb.mockImplementation((climbUuid: string, patch: ClimbAuthoredPatch) => {
      queueState = queueReducer(queueState, { type: 'REFRESH_AUTHORED_CLIMB', payload: { climbUuid, patch } });
    });
  });

  async function saveWithFrames(
    result: { current: ReturnType<typeof useCreateClimbScreen> },
    name: string,
    frames: string,
  ) {
    createClimb.generateFramesString.mockReturnValue(frames);
    act(() => result.current.setName(name));
    await act(async () => {
      await result.current.handleSave();
    });
  }

  it('edit, save, move a hold, save again: the queued climb drops its version', async () => {
    board.saveClimb.mockResolvedValue({ uuid: 'climb-x', createdAt: null, publishedAt: null, isDraft: true });
    board.updateClimb.mockResolvedValue({ uuid: 'climb-x', createdAt: null, publishedAt: null, isDraft: true });
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    await saveWithFrames(result, 'First Save', FIRST_SAVE_FRAMES);
    await saveWithFrames(result, 'Second Save', SECOND_SAVE_FRAMES);
    expect(board.updateClimb).toHaveBeenCalledTimes(1);
    // Both saves offered the queue an item.
    expect(queue.setCurrentClimb).toHaveBeenCalledTimes(2);

    // The reducer kept the FIRST save's item (same uuid, already current) and
    // the refresh put the second save's holds on it.
    const current = queueState.currentClimbQueueItem;
    expect(current?.climb.uuid).toBe('climb-x');
    expect(current?.climb.frames).toBe(SECOND_SAVE_FRAMES);
    expect(queueState.queue).toHaveLength(1);
    // The refresh moved the holds, so the reducer cleared the item's version.
    expect(current?.climb.revisionNumber).toBeNull();
    expect(current?.climb.holdsRevisionNumber).toBeNull();
  });

  it('after one save, the queued climb carries no version', async () => {
    board.saveClimb.mockResolvedValue({ uuid: 'climb-y', createdAt: null, publishedAt: null, isDraft: true });
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    await saveWithFrames(result, 'Only Save', FIRST_SAVE_FRAMES);

    expect(queueState.currentClimbQueueItem?.climb.revisionNumber).toBeUndefined();
  });

  it('Set Active with unsaved work-in-progress holds: no version on the item', async () => {
    board.saveClimb.mockResolvedValue({ uuid: 'climb-z', createdAt: null, publishedAt: null, isDraft: true });
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));
    await saveWithFrames(result, 'Saved Once', FIRST_SAVE_FRAMES);

    // Leave the saved climb current, move on in the queue, then come back to
    // the editor's work in progress with Set Active.
    const otherItem = climbToQueueItem({ ...queueState.currentClimbQueueItem!.climb, uuid: 'another' } as Climb, {
      uuid: 'another-item',
    });
    act(() => {
      queue.setCurrentClimb(otherItem);
    });
    expect(queueState.currentClimbQueueItem?.uuid).toBe('another-item');

    createClimb.generateFramesString.mockReturnValue(WIP_FRAMES);
    act(() => result.current.handleSetActive());

    // The saved row's uuid is reused, and its item is still in the queue, so
    // the reducer makes the WIP item current without adding it again.
    const current = queueState.currentClimbQueueItem;
    expect(current?.climb.uuid).toBe('climb-z');
    expect(current?.climb.frames).toBe(WIP_FRAMES);
    expect(current?.climb.revisionNumber).toBeUndefined();
  });

  it('Set Active on a climb that was never saved: no version on the item', () => {
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));
    createClimb.generateFramesString.mockReturnValue(WIP_FRAMES);

    act(() => result.current.setName('Never Saved'));
    act(() => result.current.handleSetActive());

    expect(queueState.currentClimbQueueItem?.climb.frames).toBe(WIP_FRAMES);
    expect(queueState.currentClimbQueueItem?.climb.revisionNumber).toBeUndefined();
  });

  it('the editor never puts a version on the climb it queues, whatever updateClimb returns', async () => {
    board.saveClimb.mockResolvedValue({ uuid: 'climb-v', createdAt: null, publishedAt: null, isDraft: true });
    // A backend that answers with numbers the document does not even select.
    board.updateClimb.mockResolvedValue({
      uuid: 'climb-v',
      createdAt: null,
      publishedAt: null,
      isDraft: true,
      revisionNumber: 3,
      holdsRevisionNumber: 3,
    });
    const { result } = renderHook(() => useCreateClimbScreen({ board: kilterBoard }));

    await saveWithFrames(result, 'First Save', FIRST_SAVE_FRAMES);
    await saveWithFrames(result, 'Second Save', SECOND_SAVE_FRAMES);

    for (const [item] of queue.setCurrentClimb.mock.calls as Array<[ClimbQueueItem]>) {
      expect(item.climb.revisionNumber).toBeUndefined();
      expect(item.climb.holdsRevisionNumber).toBeUndefined();
    }
  });
});
