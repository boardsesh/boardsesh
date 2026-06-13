import { describe, expect, it } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';
import { buildMobileFeedbackEnrichment, clipFeedbackString } from '../feedback-enrichment';

const activeBoard: UserBoard = {
  id: 1,
  uuid: 'board-uuid',
  slug: 'home-board',
  ownerId: 'user-1',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 2,
  setIds: '10,12',
  name: 'Home board',
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
};

const currentClimbQueueItem: ClimbQueueItem = {
  uuid: 'queue-item-1',
  climb: {
    uuid: 'climb-uuid',
    setter_username: 'setter',
    name: 'Orbit',
    frames: 'p1r12',
    angle: 40,
    ascensionist_count: 12,
    difficulty: 'V6',
    quality_average: '3.5',
    stars: 4,
    difficulty_error: '0.3',
    benchmark_difficulty: null,
  },
};

describe('buildMobileFeedbackEnrichment', () => {
  it('derives board, climb, session, and route context', () => {
    expect(
      buildMobileFeedbackEnrichment({
        activeBoard,
        currentClimbQueueItem,
        sessionId: 'session-1',
        pathname: '/(tabs)/climbs',
      }),
    ).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 2,
      setIds: [10, 12],
      angle: 40,
      context: {
        climbUuid: 'climb-uuid',
        climbName: 'Orbit',
        difficulty: 'V6',
        sessionId: 'session-1',
        url: '/(tabs)/climbs',
      },
    });
  });

  it('returns null board and context fields when no useful context exists', () => {
    expect(
      buildMobileFeedbackEnrichment({
        activeBoard: null,
        currentClimbQueueItem: null,
        sessionId: null,
        pathname: ' ',
      }),
    ).toEqual({
      boardName: null,
      layoutId: null,
      sizeId: null,
      setIds: null,
      angle: null,
      context: null,
    });
  });
});

describe('clipFeedbackString', () => {
  it('trims empty values and clips long strings', () => {
    expect(clipFeedbackString('   ', 10)).toBeUndefined();
    expect(clipFeedbackString('abcdefghijkl', 5)).toBe('abcde');
  });
});
