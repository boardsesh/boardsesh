// Pins the /embed/** access-control decisions. These are SECURITY tests: the
// backend `board(boardUuid)` / `gym(gymUuid)` resolvers serve PRIVATE entities
// fully enriched to anonymous callers, so the embed layer's own gates are the
// only thing between a guessable uuid and a private board/gym leaking through
// a frameable, cookieless page.

import { describe, expect, it } from 'vitest';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';
import {
  DEFAULT_EMBED_LEADERBOARD_PERIOD,
  embedAttributionHref,
  parseEmbedLeaderboardPeriod,
  resolveEmbedBrandGym,
  resolveEmbedLeaderboardScope,
  resolveEmbeddableBoard,
} from '../embed-access';

function makeBoard(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: 'board-uuid-1',
    slug: 'main-kilter',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    name: 'Main Kilter',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    boardId: 42,
    ...overrides,
  };
}

function makeGym(overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: 'gym-uuid-1',
    slug: 'boulder-barn',
    ownerId: 'owner-1',
    name: 'Boulder Barn',
    isPublic: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    boardCount: 1,
    boardTypes: ['kilter'],
    boardSummaries: [{ boardType: 'kilter', angle: 40 }],
    memberCount: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    isMember: false,
    canEdit: false,
    canGrantAccess: false,
    canClaim: false,
    isClaimed: true,
    canClaimByDomain: false,
    ...overrides,
  };
}

describe('resolveEmbeddableBoard', () => {
  it('passes a public board with a presence id through, narrowed', () => {
    const embeddable = resolveEmbeddableBoard(makeBoard());
    expect(embeddable).not.toBeNull();
    expect(embeddable?.boardId).toBe(42);
  });

  it('SECURITY: rejects a PRIVATE board even though the resolver returned it', () => {
    expect(resolveEmbeddableBoard(makeBoard({ isPublic: false }))).toBeNull();
  });

  it('SECURITY: rejects a private board that somehow still carries a boardId', () => {
    expect(resolveEmbeddableBoard(makeBoard({ isPublic: false, boardId: 42 }))).toBeNull();
  });

  it('defense in depth: rejects a board with a null/absent presence id', () => {
    expect(resolveEmbeddableBoard(makeBoard({ boardId: null }))).toBeNull();
    expect(resolveEmbeddableBoard(makeBoard({ boardId: undefined }))).toBeNull();
  });

  it('rejects a missing board', () => {
    expect(resolveEmbeddableBoard(null)).toBeNull();
  });

  it('unlisted-but-public boards stay embeddable (unlisted = link-only, and the embed IS the link)', () => {
    expect(resolveEmbeddableBoard(makeBoard({ isUnlisted: true }))).not.toBeNull();
  });
});

describe('resolveEmbedBrandGym', () => {
  it('passes a public gym through', () => {
    expect(resolveEmbedBrandGym(makeGym())?.name).toBe('Boulder Barn');
  });

  it('SECURITY: strips a PRIVATE gym — no name/logo/colours on any embed', () => {
    expect(resolveEmbedBrandGym(makeGym({ isPublic: false }))).toBeNull();
  });

  it('handles an absent gym', () => {
    expect(resolveEmbedBrandGym(null)).toBeNull();
  });
});

describe('embedAttributionHref', () => {
  it('points at the public gym page when the gym has a slug', () => {
    expect(embedAttributionHref(makeGym())).toBe('/gym/boulder-barn');
  });

  it('falls back to the homepage for a slugless gym or no gym', () => {
    expect(embedAttributionHref(makeGym({ slug: null }))).toBe('https://boardsesh.com');
    expect(embedAttributionHref(null)).toBe('https://boardsesh.com');
  });
});

describe('parseEmbedLeaderboardPeriod', () => {
  it('accepts the three period modes', () => {
    expect(parseEmbedLeaderboardPeriod('day')).toBe('day');
    expect(parseEmbedLeaderboardPeriod('week')).toBe('week');
    expect(parseEmbedLeaderboardPeriod('month')).toBe('month');
  });

  it('defaults to week, and NEVER yields session (embeds stay WebSocket-free)', () => {
    expect(DEFAULT_EMBED_LEADERBOARD_PERIOD).toBe('week');
    expect(parseEmbedLeaderboardPeriod(undefined)).toBe('week');
    expect(parseEmbedLeaderboardPeriod('session')).toBe('week');
    expect(parseEmbedLeaderboardPeriod('yesterday')).toBe('week');
    expect(parseEmbedLeaderboardPeriod('')).toBe('week');
  });
});

describe('resolveEmbedLeaderboardScope', () => {
  const kilter = makeBoard({ uuid: 'board-uuid-1', name: 'Main Kilter' });
  const tension = makeBoard({ uuid: 'board-uuid-2', name: 'Tension Wall' });

  it('scopes to a board that is in the visible list', () => {
    const { scopedBoard, scopedBoards } = resolveEmbedLeaderboardScope([kilter, tension], 'board-uuid-2');
    expect(scopedBoard?.name).toBe('Tension Wall');
    expect(scopedBoards).toEqual([tension]);
  });

  it('widens to all boards when no scope is given', () => {
    const { scopedBoard, scopedBoards } = resolveEmbedLeaderboardScope([kilter, tension], undefined);
    expect(scopedBoard).toBeNull();
    expect(scopedBoards).toEqual([kilter, tension]);
  });

  it('SECURITY: widens to all boards when the uuid is not viewer-visible (e.g. a private board pasted into the query string)', () => {
    const { scopedBoard, scopedBoards } = resolveEmbedLeaderboardScope([kilter, tension], 'private-board-uuid');
    expect(scopedBoard).toBeNull();
    expect(scopedBoards).toEqual([kilter, tension]);
  });
});
