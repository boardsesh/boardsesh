import { describe, it, expect } from 'vite-plus/test';
import { findMatchingBoard } from '../find-matching-board';
import type { UserBoard } from '@boardsesh/shared-schema';

const makeBoard = (overrides: Partial<UserBoard> = {}): UserBoard => ({
  id: 1,
  uuid: 'board-1',
  slug: 'my-kilter',
  ownerId: 'user-1',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 12,
  setIds: '1,2',
  name: 'My Kilter',
  isPublic: true,
  isUnlisted: false,
  hideLocation: false,
  isOwned: true,
  angle: 40,
  isAngleAdjustable: true,
  createdAt: '2026-01-01',
  totalAscents: 0,
  uniqueClimbers: 0,
  followerCount: 0,
  commentCount: 0,
  isFollowedByMe: false,
  ...overrides,
});

describe('findMatchingBoard', () => {
  const kilterBoard = makeBoard({
    uuid: 'b-1',
    slug: 'my-kilter',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 12,
  });
  const tensionBoard = makeBoard({
    uuid: 'b-2',
    slug: 'my-tension',
    boardType: 'tension',
    layoutId: 2,
    sizeId: 8,
  });
  const boards = [kilterBoard, tensionBoard];

  it('should return null for null boards', () => {
    expect(findMatchingBoard(null, 'my-kilter')).toBeNull();
  });

  it('should return null for undefined boards', () => {
    expect(findMatchingBoard(undefined, 'my-kilter')).toBeNull();
  });

  it('should return null for empty boards array', () => {
    expect(findMatchingBoard([], 'my-kilter')).toBeNull();
  });

  it('should return null when neither slug nor config provided', () => {
    expect(findMatchingBoard(boards)).toBeNull();
  });

  it('should match by slug', () => {
    expect(findMatchingBoard(boards, 'my-kilter')).toBe(kilterBoard);
    expect(findMatchingBoard(boards, 'my-tension')).toBe(tensionBoard);
  });

  it('should return null for non-matching slug', () => {
    expect(findMatchingBoard(boards, 'nonexistent')).toBeNull();
  });

  it('should match by boardConfig', () => {
    expect(findMatchingBoard(boards, undefined, { boardType: 'kilter', layoutId: 1, sizeId: 12 })).toBe(kilterBoard);
    expect(findMatchingBoard(boards, undefined, { boardType: 'tension', layoutId: 2, sizeId: 8 })).toBe(tensionBoard);
  });

  it('should return null for non-matching boardConfig', () => {
    expect(findMatchingBoard(boards, undefined, { boardType: 'kilter', layoutId: 1, sizeId: 999 })).toBeNull();
    expect(findMatchingBoard(boards, undefined, { boardType: 'kilter', layoutId: 999, sizeId: 12 })).toBeNull();
    expect(findMatchingBoard(boards, undefined, { boardType: 'moonboard', layoutId: 1, sizeId: 12 })).toBeNull();
  });

  it('should prefer slug over boardConfig when both provided', () => {
    // Slug matches kilter, config matches tension — slug wins
    const result = findMatchingBoard(boards, 'my-kilter', {
      boardType: 'tension',
      layoutId: 2,
      sizeId: 8,
    });
    expect(result).toBe(kilterBoard);
  });

  it('should fall back to boardConfig when slug is undefined', () => {
    const result = findMatchingBoard(boards, undefined, {
      boardType: 'tension',
      layoutId: 2,
      sizeId: 8,
    });
    expect(result).toBe(tensionBoard);
  });
});
