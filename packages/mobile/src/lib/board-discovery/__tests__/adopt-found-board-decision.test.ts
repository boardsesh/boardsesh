import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import {
  boardOwnershipForViewer,
  decideAdoptFoundBoard,
  shouldFollowBoard,
  type AdoptFoundBoardParams,
} from '../adopt-found-board-decision';

const base: AdoptFoundBoardParams = {
  isViewerOwner: false,
  isFollowedByMe: false,
  isPrivate: false,
  offlineEnabled: false,
  autoOffline: false,
  alreadyEnabledOffline: false,
  offerOffline: true,
};

const VIEWER = 'viewer-1';
// The Aurora pin sync writes gym boards as the system user.
const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';

const makeBoard = (over: Partial<UserBoard>): UserBoard =>
  ({
    uuid: 'board-1',
    name: 'Crux Kilter 40°',
    ownerId: 'setter-1',
    isOwned: true,
    isPublic: true,
    isFollowedByMe: false,
    ...over,
  }) as unknown as UserBoard;

/** The decision a pick makes for `board`, seen by VIEWER. */
const followsWhenPicked = (board: UserBoard, viewerId: string | undefined = VIEWER) =>
  decideAdoptFoundBoard({ ...base, ...boardOwnershipForViewer(board, viewerId) }).follow;

describe('decideAdoptFoundBoard', () => {
  describe('follow', () => {
    it('follows a board that is new to the user (not theirs, not followed)', () => {
      expect(decideAdoptFoundBoard(base).follow).toBe(true);
    });

    it('does not follow a board the user already follows', () => {
      expect(decideAdoptFoundBoard({ ...base, isFollowedByMe: true }).follow).toBe(false);
    });

    it('does not follow a board the user built', () => {
      expect(decideAdoptFoundBoard({ ...base, isViewerOwner: true }).follow).toBe(false);
    });

    // followBoard is idempotent and myBoards is "owned OR followed", so the worst
    // an unresolved viewer can do is follow their own board.
    it('still follows a public board while the viewer is unresolved', () => {
      expect(decideAdoptFoundBoard({ ...base, isViewerOwner: undefined }).follow).toBe(true);
    });

    // The server refuses to follow someone else's private board, so asking would
    // only produce a "Could not follow" toast.
    it('does not follow a private board', () => {
      expect(decideAdoptFoundBoard({ ...base, isPrivate: true }).follow).toBe(false);
      expect(decideAdoptFoundBoard({ ...base, isPrivate: true, isViewerOwner: undefined }).follow).toBe(false);
    });
  });

  describe('offline offer', () => {
    it('does nothing about offline when the feature flag is off', () => {
      expect(decideAdoptFoundBoard({ ...base, offlineEnabled: false }).offline).toBe('none');
    });

    it('asks for a freshly-found board when the flag is on and auto-offline is off', () => {
      expect(decideAdoptFoundBoard({ ...base, offlineEnabled: true }).offline).toBe('ask');
    });

    it('auto-downloads a freshly-found board when auto-offline is on', () => {
      expect(decideAdoptFoundBoard({ ...base, offlineEnabled: true, autoOffline: true }).offline).toBe('auto');
    });

    it('never asks when the board is already enabled for offline', () => {
      expect(decideAdoptFoundBoard({ ...base, offlineEnabled: true, alreadyEnabledOffline: true }).offline).toBe(
        'none',
      );
    });

    it('does not nag when re-selecting an already-followed board (auto-offline off)', () => {
      expect(decideAdoptFoundBoard({ ...base, isFollowedByMe: true, offlineEnabled: true }).offline).toBe('none');
    });

    it('does not nag the owner of the board', () => {
      expect(decideAdoptFoundBoard({ ...base, isViewerOwner: true, offlineEnabled: true }).offline).toBe('none');
    });

    // An owner whose id hasn't loaded yet must not be asked about their own wall.
    it('asks nothing about offline while the viewer is unresolved', () => {
      expect(decideAdoptFoundBoard({ ...base, isViewerOwner: undefined, offlineEnabled: true }).offline).toBe('none');
    });

    // The onboarding bind and the drawer's wall switch: a dialog there interrupts.
    it('never asks when the caller has no room for a dialog', () => {
      expect(decideAdoptFoundBoard({ ...base, offlineEnabled: true, offerOffline: false })).toEqual({
        follow: true,
        offline: 'none',
      });
    });

    it('still auto-downloads when the caller has no room for a dialog', () => {
      expect(
        decideAdoptFoundBoard({ ...base, offlineEnabled: true, autoOffline: true, offerOffline: false }).offline,
      ).toBe('auto');
    });

    it('auto-downloads an already-followed board when auto-offline is on and it is not enabled yet', () => {
      const decision = decideAdoptFoundBoard({
        ...base,
        isFollowedByMe: true,
        offlineEnabled: true,
        autoOffline: true,
      });
      expect(decision.follow).toBe(false);
      expect(decision.offline).toBe('auto');
    });
  });
});

// The #5654 bug: `isOwned` is the creator's "a real wall" flag, not "yours".
describe('picking a real board', () => {
  it("follows someone else's board even though its creator marked it as their own wall", () => {
    expect(followsWhenPicked(makeBoard({ ownerId: 'setter-1', isOwned: true }))).toBe(true);
  });

  it('does not follow a board the viewer built', () => {
    expect(followsWhenPicked(makeBoard({ ownerId: VIEWER, isOwned: true }))).toBe(false);
  });

  it('does not follow a board the viewer built, even with the physical-wall switch off', () => {
    expect(followsWhenPicked(makeBoard({ ownerId: VIEWER, isOwned: false }))).toBe(false);
  });

  it('does not follow a board the viewer already follows', () => {
    expect(followsWhenPicked(makeBoard({ ownerId: 'setter-1', isFollowedByMe: true }))).toBe(false);
  });

  it('follows an Aurora gym pin (isOwned false, owned by the system user)', () => {
    expect(followsWhenPicked(makeBoard({ ownerId: SYSTEM_OWNER, isOwned: false }))).toBe(true);
  });

  it("does not try to follow someone else's private board", () => {
    expect(followsWhenPicked(makeBoard({ ownerId: 'friend-1', isPublic: false }))).toBe(false);
  });
});

describe('boardOwnershipForViewer', () => {
  it('reports an unresolved viewer as unknown, never as "not yours"', () => {
    expect(boardOwnershipForViewer(makeBoard({}), undefined).isViewerOwner).toBeUndefined();
  });

  it('matches the follow half of the full decision', () => {
    const board = makeBoard({ ownerId: 'setter-1' });
    expect(shouldFollowBoard(boardOwnershipForViewer(board, VIEWER))).toBe(followsWhenPicked(board));
  });
});
