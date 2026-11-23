import { describe, it, expect } from 'vite-plus/test';
import { canManageGymBoards, linkableBoards } from '../gym-board-permissions';

const GYM_UUID = 'gym-1';
const OWNER = 'user-owner';
const OTHER = 'user-other';

describe('canManageGymBoards', () => {
  it('allows the gym owner', () => {
    expect(canManageGymBoards({ ownerId: OWNER, myRole: null }, OWNER)).toBe(true);
  });

  it('allows a gym admin who is not the owner', () => {
    expect(canManageGymBoards({ ownerId: OWNER, myRole: 'admin' }, OTHER)).toBe(true);
  });

  it('denies a gym editor (backend linkBoardToGym requires owner/admin)', () => {
    expect(canManageGymBoards({ ownerId: OWNER, myRole: 'editor' }, OTHER)).toBe(false);
  });

  it('denies a signed-out viewer', () => {
    expect(canManageGymBoards({ ownerId: OWNER, myRole: 'admin' }, null)).toBe(false);
  });
});

describe('linkableBoards', () => {
  const boards = [
    { uuid: 'b1', ownerId: OWNER, gymUuid: null }, // linkable
    { uuid: 'b2', ownerId: OTHER, gymUuid: null }, // followed board, not owned
    { uuid: 'b3', ownerId: OWNER, gymUuid: GYM_UUID }, // already on this gym
    { uuid: 'b4', ownerId: OWNER, gymUuid: 'gym-2' }, // owned, on another gym — still offerable
    { uuid: 'b5', ownerId: OWNER, gymUuid: null }, // in linkedBoardUuids (fresh link)
  ];

  it('keeps only owned boards not already on this gym', () => {
    const result = linkableBoards(boards, GYM_UUID, new Set(['b5']), OWNER);
    expect(result.map((board) => board.uuid)).toEqual(['b1', 'b4']);
  });

  it('returns nothing for a signed-out viewer', () => {
    expect(linkableBoards(boards, GYM_UUID, new Set(), null)).toEqual([]);
  });
});
