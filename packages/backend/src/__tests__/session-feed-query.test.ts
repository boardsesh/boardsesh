import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const sessionFeedTestState = vi.hoisted(() => {
  const executeMock = vi.fn();
  const selectWhereMock = vi.fn();
  const selectFromMock = vi.fn(() => ({
    where: selectWhereMock,
  }));
  const selectMock = vi.fn(() => ({
    from: selectFromMock,
  }));

  return {
    executeMock,
    selectWhereMock,
    selectFromMock,
    selectMock,
  };
});

vi.mock('../db/client', () => {
  const fakeDb = {
    execute: sessionFeedTestState.executeMock,
    select: sessionFeedTestState.selectMock,
  };
  // sessionGroupedFeed reads from `dbRead`; alias it to the same fake so the
  // existing call assertions still hit `executeMock` / `selectMock`.
  return {
    db: fakeDb,
    dbRead: fakeDb,
  };
});

const { sessionGroupedFeed } = await import('../graphql/resolvers/social/session-feed').then(
  (module) => module.sessionFeedQueries,
);

function sqlToText(query: unknown): string {
  if (!query || typeof query !== 'object') return '';
  const sqlQuery = query as { queryChunks?: unknown[] };
  if (!Array.isArray(sqlQuery.queryChunks)) return '';
  return sqlQuery.queryChunks
    .map((chunk) => {
      if (!chunk || typeof chunk !== 'object') return '';
      const c = chunk as { value?: string[]; queryChunks?: unknown[] };
      // StringChunk: has .value (string[])
      if (Array.isArray(c.value)) return c.value.join('');
      // Nested SQL object: has .queryChunks
      if (Array.isArray(c.queryChunks)) return sqlToText(c);
      return '';
    })
    .join('');
}

describe('sessionGroupedFeed user filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    sessionFeedTestState.executeMock
      .mockResolvedValueOnce([
        {
          session_id: 'party-1',
          session_type: 'party',
          session_first_tick: '2024-01-15T10:00:00.000Z',
          session_last_tick: '2024-01-15T12:00:00.000Z',
          tick_count: 8,
          total_sends: 5,
          total_flashes: 2,
          total_attempts: 6,
          vote_score: 4,
          vote_up: 5,
          vote_down: 1,
          comment_count: 2,
          daily_user_id: null,
          daily_date: null,
          daily_display_name: null,
          daily_avatar_url: null,
          daily_board_types: null,
          highlight_tick_uuid: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          session_id: 'party-1',
          userId: 'user-1',
          displayName: 'Alex',
          avatarUrl: null,
          sends: 3,
          flashes: 1,
          attempts: 2,
        },
        {
          session_id: 'party-1',
          userId: 'user-2',
          displayName: 'Sam',
          avatarUrl: null,
          sends: 2,
          flashes: 1,
          attempts: 4,
        },
      ])
      .mockResolvedValueOnce([
        {
          session_id: 'party-1',
          diff_num: 10,
          flash: 2,
          send: 3,
          attempt: 6,
        },
      ])
      .mockResolvedValueOnce([
        {
          session_id: 'party-1',
          board_types: ['kilter'],
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    sessionFeedTestState.selectWhereMock.mockResolvedValue([
      {
        id: 'party-1',
        name: 'Lunch Laps',
        goal: 'Finish the set',
        createdByUserId: 'user-1',
      },
    ]);
  });

  it('filters party sessions by participant but returns whole-session aggregates', async () => {
    const result = await sessionGroupedFeed(null, {
      input: {
        userId: 'user-1',
        limit: 20,
      },
    });

    const mainQueryText = sqlToText(sessionFeedTestState.executeMock.mock.calls[0][0]);

    expect(mainQueryText).toContain('eligible_sessions');
    expect(mainQueryText).toContain('INNER JOIN eligible_sessions es ON es.session_id = t.session_id');

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: 'party-1',
      sessionType: 'party',
      totalSends: 5,
      totalFlashes: 2,
      totalAttempts: 6,
      hardestGrade: '4a/V0',
      hardestSend: null,
      featuredBeta: null,
      socialEntityType: 'session',
      socialEntityId: 'party-1',
      participants: [
        expect.objectContaining({ userId: 'user-1', sends: 3 }),
        expect.objectContaining({ userId: 'user-2', sends: 2 }),
      ],
    });
  });
});
