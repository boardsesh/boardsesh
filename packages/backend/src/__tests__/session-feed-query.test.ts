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

  const guardMock = vi.fn();

  // sessionGroupedFeed's main query runs inside withSerialPlan, which issues
  // SET LOCAL max_parallel_workers_per_gather = 0 first (#4105). Route that
  // statement to its own spy so the executeMock sequence these tests index into
  // stays the resolver's own queries — while still being assertable.
  const guardText = (query: unknown): string => {
    if (!query || typeof query !== 'object') return '';
    const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return '';
    return chunks
      .map((chunk) => {
        if (!chunk || typeof chunk !== 'object') return '';
        const typed = chunk as { value?: unknown; queryChunks?: unknown[] };
        if (Array.isArray(typed.value)) return typed.value.join('');
        if (Array.isArray(typed.queryChunks)) return guardText(chunk);
        return '';
      })
      .join('');
  };
  const isSerialPlanGuard = (query: unknown) => guardText(query).includes('max_parallel_workers_per_gather');

  return {
    executeMock,
    selectWhereMock,
    selectFromMock,
    selectMock,
    guardMock,
    isSerialPlanGuard,
  };
});

vi.mock('../db/client', () => {
  const transaction = (callback: (tx: unknown) => unknown) =>
    callback({
      execute: (statement: unknown) => {
        if (sessionFeedTestState.isSerialPlanGuard(statement)) {
          sessionFeedTestState.guardMock(statement);
          return Promise.resolve([]);
        }
        return sessionFeedTestState.executeMock(statement);
      },
      select: sessionFeedTestState.selectMock,
    });

  const fakeDb = {
    execute: sessionFeedTestState.executeMock,
    select: sessionFeedTestState.selectMock,
    transaction,
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
      // session_base row: with a userId filter the resolver now scopes the
      // aggregates to that climber's own ticks, so this is user-1's slice (3
      // sends), NOT the whole party's 5. participants[] below stays whole-session.
      .mockResolvedValueOnce([
        {
          session_id: 'party-1',
          session_type: 'party',
          session_first_tick: '2024-01-15T10:00:00.000Z',
          session_last_tick: '2024-01-15T12:00:00.000Z',
          tick_count: 3,
          total_sends: 3,
          total_flashes: 1,
          total_attempts: 2,
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
      // Grade distribution is likewise the viewer's own slice (sums to 3 sends).
      .mockResolvedValueOnce([
        {
          session_id: 'party-1',
          diff_num: 10,
          flash: 1,
          send: 2,
          attempt: 2,
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

  it('scopes party-session aggregates to the participant, keeping participants[] whole-session', async () => {
    const result = await sessionGroupedFeed(null, {
      input: {
        userId: 'user-1',
        limit: 20,
      },
    });

    const mainQueryText = sqlToText(sessionFeedTestState.executeMock.mock.calls[0][0]);
    const participantsQueryText = sqlToText(sessionFeedTestState.executeMock.mock.calls[1][0]);
    const gradeDistQueryText = sqlToText(sessionFeedTestState.executeMock.mock.calls[2][0]);
    const boardTypesQueryText = sqlToText(sessionFeedTestState.executeMock.mock.calls[3][0]);
    const hardestSendsQueryText = sqlToText(sessionFeedTestState.executeMock.mock.calls[4][0]);
    const featuredBetaQueryText = sqlToText(sessionFeedTestState.executeMock.mock.calls[5][0]);

    // Membership still decides WHICH sessions appear…
    expect(mainQueryText).toContain('eligible_sessions');
    expect(mainQueryText).toContain('INNER JOIN eligible_sessions es ON es.session_id = t.session_id');
    // …and the aggregates + grade/board/hardest/beta enrichment are now scoped to
    // the filtered climber's own ticks, so a party-mate can't inflate them.
    expect(mainQueryText).toContain('AND t.user_id =');
    expect(gradeDistQueryText).toContain('AND t.user_id =');
    expect(boardTypesQueryText).toContain('AND t.user_id =');
    expect(hardestSendsQueryText).toContain('AND t.user_id =');
    expect(featuredBetaQueryText).toContain('AND t.user_id =');
    // participants[] is the leaderboard — it must stay whole-session, never scoped.
    expect(participantsQueryText).not.toContain('AND t.user_id =');

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: 'party-1',
      sessionType: 'party',
      totalSends: 3,
      totalFlashes: 1,
      totalAttempts: 2,
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

  it('does NOT scope aggregates when no userId is set (the public/social feed)', async () => {
    const result = await sessionGroupedFeed(null, {
      input: {
        limit: 20,
      },
    });

    const mainQueryText = sqlToText(sessionFeedTestState.executeMock.mock.calls[0][0]);
    const gradeDistQueryText = sqlToText(sessionFeedTestState.executeMock.mock.calls[2][0]);

    // No participant filter at all — every party session, whole-session aggregates.
    expect(mainQueryText).not.toContain('eligible_sessions');
    expect(mainQueryText).not.toContain('AND t.user_id =');
    expect(gradeDistQueryText).not.toContain('AND t.user_id =');

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe('party-1');
  });
});
