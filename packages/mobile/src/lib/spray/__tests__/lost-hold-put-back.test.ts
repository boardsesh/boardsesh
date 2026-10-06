import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CreateClimbDraft } from '../../create-climb-draft-store';

/**
 * The "Put this hold back on the wall" round trip (#5493): the climb editor
 * closes, the hold editor opens, and the climb editor reopens with its working
 * copy and the hold that went back on.
 */

const router = vi.hoisted(() => ({ push: vi.fn() }));
const registry = vi.hoisted(() => ({
  wall: null as null | { holds: { id: number; movedFromHoldId?: number }[] },
}));

vi.mock('expo-router', () => ({ router }));
vi.mock('../../../providers/sheet-presentation-provider', () => ({ SHEET_SETTLE_MS: 500 }));
vi.mock('../spray-wall-registry', () => ({ getSprayWall: () => registry.wall }));

const {
  findPutBackHoldId,
  finishLostHoldPutBack,
  getLostHoldPutBack,
  markLostHoldPutBackPublished,
  readLostHoldPutBackReturn,
  resetLostHoldPutBack,
  returnToClimbEditor,
  startLostHoldPutBack,
} = await import('../lost-hold-put-back');

const DRAFT = {
  holdsJson: '{}',
  framesJson: '[{}]',
  name: 'Arete',
  description: '',
  isDraft: false,
} as CreateClimbDraft;
const REQUEST = {
  wallUuid: 'wall-1',
  layoutId: 7,
  lostHold: { id: 42, cx: 10, cy: 20, r: 5, outline: null },
  placements: [{ frameIndex: 0, state: 'HAND' as const }],
  knownSuccessorIds: [50],
  createParams: { boardName: 'spray', layoutId: '7', editClimbUuid: 'climb-1' },
  draft: DRAFT,
};

describe('lost-hold put-back', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    router.push.mockClear();
    resetLostHoldPutBack();
    registry.wall = { holds: [{ id: 1 }, { id: 50, movedFromHoldId: 42 }] };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the climb editor first and opens the hold editor once its sheet is gone', () => {
    const closeClimbEditor = vi.fn();
    const requestId = startLostHoldPutBack(REQUEST, closeClimbEditor);
    expect(closeClimbEditor).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(router.push).toHaveBeenCalledWith(
      `/boards/spray/holds?wallUuid=wall-1&putBack=${encodeURIComponent(requestId)}`,
    );
    expect(getLostHoldPutBack(requestId)?.status).toBe('pending');
  });

  it('hands back the working copy and no hold when the owner backed out', () => {
    const requestId = startLostHoldPutBack(REQUEST, vi.fn());
    expect(readLostHoldPutBackReturn(requestId)).toEqual({
      lostHoldId: 42,
      draft: DRAFT,
      placements: REQUEST.placements,
      newHoldId: null,
    });
  });

  it('finds the hold that went back on: linked to the lost one, and new', () => {
    const requestId = startLostHoldPutBack(REQUEST, vi.fn());
    registry.wall = { holds: [{ id: 1 }, { id: 50, movedFromHoldId: 42 }, { id: 61, movedFromHoldId: 42 }] };
    markLostHoldPutBackPublished(requestId);
    expect(readLostHoldPutBackReturn(requestId)?.newHoldId).toBe(61);
    // A read, not a take: a second render still finds it.
    expect(readLostHoldPutBackReturn(requestId)?.newHoldId).toBe(61);
    finishLostHoldPutBack(requestId);
    expect(readLostHoldPutBackReturn(requestId)).toBeNull();
  });

  it('ignores a hold that was already linked before the trip', () => {
    expect(findPutBackHoldId(REQUEST)).toBeNull();
  });

  it('reopens the climb editor on the same climb, carrying the request', () => {
    const requestId = startLostHoldPutBack(REQUEST, vi.fn());
    vi.advanceTimersByTime(500);
    router.push.mockClear();
    returnToClimbEditor(requestId);
    vi.advanceTimersByTime(500);
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/create',
      params: { ...REQUEST.createParams, putBackRequest: requestId },
    });
  });

  it('does not reopen once the wall has left the registry (a sign-out)', () => {
    const requestId = startLostHoldPutBack(REQUEST, vi.fn());
    vi.advanceTimersByTime(500);
    router.push.mockClear();
    returnToClimbEditor(requestId);
    registry.wall = null;
    vi.advanceTimersByTime(500);
    expect(router.push).not.toHaveBeenCalled();
    expect(getLostHoldPutBack(requestId)).toBeNull();
  });

  it('does not reopen for a request that is already done, or unknown', () => {
    const requestId = startLostHoldPutBack(REQUEST, vi.fn());
    vi.advanceTimersByTime(500);
    router.push.mockClear();
    finishLostHoldPutBack(requestId);
    returnToClimbEditor(requestId);
    returnToClimbEditor('nope');
    vi.advanceTimersByTime(500);
    expect(router.push).not.toHaveBeenCalled();
  });
});
