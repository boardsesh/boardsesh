import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { SessionDetail } from '@boardsesh/shared-schema';
import { buildSessionStatsUpdatedEvent } from '../graphql/resolvers/sessions/live-session-stats';

const { sessionDetailMock } = vi.hoisted(() => ({
  sessionDetailMock: vi.fn(),
}));

vi.mock('../graphql/resolvers/social/session-feed', () => ({
  sessionFeedQueries: {
    sessionDetail: sessionDetailMock,
  },
}));

function makeSessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    sessionId: 'session-1',
    sessionType: 'party',
    sessionName: 'Morning Session',
    ownerUserId: 'owner-1',
    participants: [
      {
        userId: 'user-1',
        displayName: 'Alice',
        avatarUrl: null,
        sends: 2,
        flashes: 1,
        attempts: 3,
      },
    ],
    totalSends: 2,
    totalFlashes: 1,
    totalAttempts: 3,
    tickCount: 1,
    gradeDistribution: [{ grade: 'V5', flash: 1, send: 1, attempt: 0 }],
    boardTypes: ['kilter'],
    hardestGrade: 'V5',
    firstTickAt: '2024-01-15T10:00:00.000Z',
    lastTickAt: '2024-01-15T10:10:00.000Z',
    durationMinutes: 10,
    goal: 'Send V6',
    ticks: [
      {
        uuid: 'tick-1',
        userId: 'user-1',
        climbUuid: 'climb-1',
        climbName: 'Classic',
        boardType: 'kilter',
        layoutId: 1,
        angle: 40,
        status: 'send',
        attemptCount: 2,
        difficulty: 20,
        difficultyName: 'V5',
        quality: 3,
        isMirror: false,
        isBenchmark: false,
        isNoMatch: false,
        comment: null,
        frames: 'abc',
        setterUsername: 'setter',
        climbedAt: '2024-01-15T10:10:00.000Z',
        upvotes: 2,
        totalAttempts: 2,
        betaLinks: [],
      },
    ],
    upvotes: 0,
    downvotes: 0,
    voteScore: 0,
    commentCount: 0,
    ...overrides,
  };
}

describe('buildSessionStatsUpdatedEvent', () => {
  beforeEach(() => {
    sessionDetailMock.mockReset();
  });

  it('returns null when session detail is missing', async () => {
    sessionDetailMock.mockResolvedValue(null);

    const result = await buildSessionStatsUpdatedEvent('session-1');

    expect(result).toBeNull();
    expect(sessionDetailMock).toHaveBeenCalledWith(null, { sessionId: 'session-1' });
  });

  it('maps party session detail into SessionStatsUpdated with ticks', async () => {
    const detail = makeSessionDetail();
    sessionDetailMock.mockResolvedValue(detail);

    const result = await buildSessionStatsUpdatedEvent('session-1');

    expect(result).toEqual({
      __typename: 'SessionStatsUpdated',
      sessionId: 'session-1',
      totalSends: detail.totalSends,
      totalFlashes: detail.totalFlashes,
      totalAttempts: detail.totalAttempts,
      tickCount: detail.tickCount,
      participants: detail.participants,
      gradeDistribution: detail.gradeDistribution,
      boardTypes: detail.boardTypes,
      hardestGrade: detail.hardestGrade,
      durationMinutes: detail.durationMinutes,
      goal: detail.goal,
      ticks: detail.ticks,
    });
  });

  it('returns all ticks without capping', async () => {
    const ticks = Array.from({ length: 30 }, (_, i) => ({
      uuid: `tick-${i}`,
      userId: 'user-1',
      climbUuid: `climb-${i}`,
      climbName: `Climb ${i}`,
      boardType: 'kilter',
      layoutId: 1,
      angle: 40,
      status: 'send' as const,
      attemptCount: 1,
      difficulty: 20,
      difficultyName: 'V5',
      quality: 3,
      isMirror: false,
      isBenchmark: false,
      isNoMatch: false,
      comment: null,
      frames: 'abc',
      setterUsername: 'setter',
      climbedAt: `2024-01-15T10:${String(i).padStart(2, '0')}:00.000Z`,
      upvotes: 0,
      totalAttempts: 1,
      betaLinks: [],
    }));
    const detail = makeSessionDetail({ ticks });
    sessionDetailMock.mockResolvedValue(detail);

    const result = await buildSessionStatsUpdatedEvent('session-1');

    expect(result).not.toBeNull();
    expect(result!.ticks).toHaveLength(30);
    expect(result!.ticks[0].uuid).toBe('tick-0');
    expect(result!.ticks[29].uuid).toBe('tick-29');
  });
});
