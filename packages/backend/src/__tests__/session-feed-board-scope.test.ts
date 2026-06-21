import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Verifies that a `boardUuid` scope filters the session-grouped feed by the
// EXACT board (boardsesh_ticks.board_id = user_boards.id), not the coarse
// board_type + layout_id pair a layout shares across 1,000+ gyms.

const boardScopeTestState = vi.hoisted(() => {
  const executeMock = vi.fn();
  // dbRead.select() is used twice per board-scoped call:
  //   1. board lookup:  .select({id}).from(userBoards).where(...).limit(1).then()
  //   2. session meta:  .select({...}).from(boardSessions).where(inArray(...))  (awaited)
  // where() returns a real Promise (so awaiting the meta batch works) that also
  // carries a .limit() resolving to the same rows (so the board lookup works).
  const selectQueue: unknown[][] = [];
  const selectMock = vi.fn(() => {
    const rows = selectQueue.shift() ?? [];
    const whereResult = Object.assign(Promise.resolve(rows), {
      limit: () => Promise.resolve(rows),
    });
    return { from: () => ({ where: () => whereResult }) };
  });

  return { executeMock, selectMock, selectQueue };
});

vi.mock('../db/client', () => {
  const fakeDb = {
    execute: boardScopeTestState.executeMock,
    select: boardScopeTestState.selectMock,
  };
  return { db: fakeDb, dbRead: fakeDb };
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
      if (Array.isArray(c.value)) return c.value.join('');
      if (Array.isArray(c.queryChunks)) return sqlToText(c);
      return '';
    })
    .join('');
}

// Bound parameters are bare primitives interleaved directly in queryChunks
// (e.g. the literal `4242` between two StringChunks), not wrapped objects.
function sqlPrimitiveParams(query: unknown): unknown[] {
  if (!query || typeof query !== 'object') return [];
  const sqlQuery = query as { queryChunks?: unknown[] };
  if (!Array.isArray(sqlQuery.queryChunks)) return [];
  const params: unknown[] = [];
  for (const chunk of sqlQuery.queryChunks) {
    if (chunk === null || typeof chunk !== 'object') {
      params.push(chunk);
      continue;
    }
    if (Array.isArray((chunk as { queryChunks?: unknown[] }).queryChunks)) {
      params.push(...sqlPrimitiveParams(chunk));
    }
  }
  return params;
}

const PARTY_FEED_ROW = {
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
};

// The main feed query is execute() call #0; the 6 batch-enrichment execute()
// calls follow. Stub them all so the resolver runs to completion.
function primeFeedExecuteMocks() {
  boardScopeTestState.executeMock
    .mockResolvedValueOnce([PARTY_FEED_ROW]) // main feed query
    .mockResolvedValueOnce([]) // participants batch
    .mockResolvedValueOnce([]) // grade distribution batch
    .mockResolvedValueOnce([]) // board types batch
    .mockResolvedValueOnce([]) // hardest sends batch
    .mockResolvedValueOnce([]) // session featured beta rows
    .mockResolvedValueOnce([]) // daily featured beta rows
    .mockResolvedValue([]); // any further calls
}

describe('sessionGroupedFeed board scoping (exact board_id)', () => {
  beforeEach(() => {
    // mockReset (not just clearAllMocks) drops any leftover mockResolvedValueOnce
    // queue from a prior test so each test owns the full execute() call sequence.
    boardScopeTestState.executeMock.mockReset();
    boardScopeTestState.selectMock.mockClear();
    boardScopeTestState.selectQueue.length = 0;
  });

  it('scopes to the resolved board id via t.board_id, not board_type/layout', async () => {
    // board lookup → id 4242; meta batch → the party-1 row
    boardScopeTestState.selectQueue.push(
      [{ id: 4242 }],
      [{ id: 'party-1', name: 'Lunch Laps', goal: null, createdByUserId: 'user-1' }],
    );
    primeFeedExecuteMocks();

    const result = await sessionGroupedFeed(null, {
      input: { boardUuid: 'board-uuid-abc', limit: 20 },
    });

    const mainQuery = boardScopeTestState.executeMock.mock.calls[0][0];
    const mainQueryText = sqlToText(mainQuery);

    // Exact-board filter present, against the resolved id...
    expect(mainQueryText).toContain('AND t.board_id =');
    expect(sqlPrimitiveParams(mainQuery)).toContain(4242);
    // ...and the old coarse type+layout filtering is gone everywhere.
    expect(mainQueryText).not.toContain('t.board_type =');
    expect(mainQueryText).not.toContain('cf.layout_id');

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe('party-1');
  });

  it('applies the board_id filter to the batch-enrichment queries too', async () => {
    boardScopeTestState.selectQueue.push(
      [{ id: 99 }],
      [{ id: 'party-1', name: 'Lunch Laps', goal: null, createdByUserId: 'user-1' }],
    );
    primeFeedExecuteMocks();

    await sessionGroupedFeed(null, { input: { boardUuid: 'board-uuid-xyz', limit: 20 } });

    // Participants batch (execute call #1) must carry the same exact-board filter.
    const participantsQuery = boardScopeTestState.executeMock.mock.calls[1][0];
    expect(sqlToText(participantsQuery)).toContain('AND t.board_id =');
    expect(sqlPrimitiveParams(participantsQuery)).toContain(99);
    expect(sqlToText(participantsQuery)).not.toContain('t.board_type =');
  });

  it('does not filter by board when the boardUuid does not resolve to a board', async () => {
    // board lookup returns no row → unscoped feed, no error.
    boardScopeTestState.selectQueue.push(
      [],
      [{ id: 'party-1', name: 'Lunch Laps', goal: null, createdByUserId: 'user-1' }],
    );
    primeFeedExecuteMocks();

    const result = await sessionGroupedFeed(null, {
      input: { boardUuid: 'unknown-uuid', limit: 20 },
    });

    const mainQueryText = sqlToText(boardScopeTestState.executeMock.mock.calls[0][0]);
    expect(mainQueryText).not.toContain('t.board_id =');
    expect(mainQueryText).not.toContain('t.board_type =');
    expect(result.sessions).toHaveLength(1);
  });

  it('is unscoped when no boardUuid is provided', async () => {
    // No board lookup happens; only the meta batch select runs.
    boardScopeTestState.selectQueue.push([
      { id: 'party-1', name: 'Lunch Laps', goal: null, createdByUserId: 'user-1' },
    ]);
    primeFeedExecuteMocks();

    await sessionGroupedFeed(null, { input: { limit: 20 } });

    const mainQueryText = sqlToText(boardScopeTestState.executeMock.mock.calls[0][0]);
    expect(mainQueryText).not.toContain('t.board_id =');
    // The board lookup select() should not have been invoked at all.
    expect(boardScopeTestState.selectMock).toHaveBeenCalledTimes(1);
  });
});
