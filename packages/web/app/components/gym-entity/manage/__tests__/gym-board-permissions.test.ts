import { describe, it, expect } from 'vite-plus/test';
import { canManageGymBoards, canUnlinkBoard, canDeleteGymBoard, linkableBoards } from '../gym-board-permissions';

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

describe('canUnlinkBoard', () => {
  it('allows the board owner', () => {
    expect(canUnlinkBoard({ ownerId: OWNER }, OWNER)).toBe(true);
  });

  it('denies everyone else, including gym admins', () => {
    expect(canUnlinkBoard({ ownerId: OWNER }, OTHER)).toBe(false);
    expect(canUnlinkBoard({ ownerId: OWNER }, null)).toBe(false);
  });
});

describe('canDeleteGymBoard', () => {
  const gym = { uuid: GYM_UUID, ownerId: OWNER, myRole: null };
  const board = { ownerId: OTHER, gymUuid: GYM_UUID };

  it('allows the board owner without gym management permissions', () => {
    expect(canDeleteGymBoard(board, gym, OTHER)).toBe(true);
  });

  it('allows the linked gym owner and admin', () => {
    expect(canDeleteGymBoard(board, gym, OWNER)).toBe(true);
    expect(canDeleteGymBoard(board, { ...gym, myRole: 'admin' }, 'gym-admin')).toBe(true);
  });

  it('denies gym editors, moderators with no gym role, and signed-out viewers', () => {
    expect(canDeleteGymBoard(board, { ...gym, myRole: 'editor' }, 'gym-editor')).toBe(false);
    expect(canDeleteGymBoard(board, gym, 'community-admin')).toBe(false);
    expect(canDeleteGymBoard(board, { ...gym, myRole: 'admin' }, null)).toBe(false);
  });

  it('denies gym management access to unlinked boards and boards at another gym', () => {
    expect(canDeleteGymBoard({ ...board, gymUuid: null }, gym, OWNER)).toBe(false);
    expect(canDeleteGymBoard({ ...board, gymUuid: 'another-gym' }, gym, OWNER)).toBe(false);
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
