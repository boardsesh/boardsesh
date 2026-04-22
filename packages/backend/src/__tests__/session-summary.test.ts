import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Shared mock state, declared with vi.hoisted to ensure availability before mock setup
const mockState = vi.hoisted(() => ({
  selectCallIndex: 0,
  sessionRows: [] as Record<string, unknown>[],
  gradeDistRows: [] as Record<string, unknown>[],
  hardestRows: [] as Record<string, unknown>[],
  participantRows: [] as Record<string, unknown>[],
}));

// Chainable mock builder, also hoisted for use in mock factory
const { createChainableMock } = vi.hoisted(() => ({
  createChainableMock: (resolveData: unknown) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'from', 'where', 'leftJoin', 'groupBy', 'orderBy', 'limit']) {
      chain[method] = (..._: unknown[]) => chain;
    }
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(resolveData).then(resolve, reject);
    return chain;
  },
}));

// Mock the database client — all query builder chains resolve to mock data
vi.mock('../db/client', () => ({
  db: new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === 'select') {
          return (..._: unknown[]) => {
            const index = mockState.selectCallIndex++;
            const dataByIndex = [mockState.sessionRows, mockState.gradeDistRows, mockState.hardestRows];
            return createChainableMock(dataByIndex[index] ?? []);
          };
        }
        if (prop === 'execute') {
          return (..._: unknown[]) => Promise.resolve(mockState.participantRows);
        }
      },
    },
  ),
}));

// Mock schema modules with empty objects (query args are ignored by the chain mock)
vi.mock('../db/schema', () => ({ sessions: {} }));
vi.mock('@boardsesh/db/schema', () => ({
  boardseshTicks: {},
  boardDifficultyGrades: {},
  boardClimbs: {},
}));

// Mock drizzle-orm functions to prevent errors from passing mock schema objects
vi.mock('drizzle-orm', () => ({
  eq: (..._: unknown[]) => ({}),
  and: (..._: unknown[]) => ({}),
  inArray: (..._: unknown[]) => ({}),
  sql: (..._: unknown[]) => ({}),
  count: (..._: unknown[]) => ({}),
  desc: (..._: unknown[]) => ({}),
  isNotNull: (..._: unknown[]) => ({}),
}));

import { generateSessionSummary } from '../graphql/resolvers/sessions/session-summary';

describe('generateSessionSummary', () => {
  beforeEach(() => {
    mockState.selectCallIndex = 0;
    mockState.sessionRows = [];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [];
    mockState.participantRows = [];
  });

  it('returns null when session is not found', async () => {
    mockState.sessionRows = [];

    const result = await generateSessionSummary('nonexistent-id');
    expect(result).toBeNull();
  });

  it('returns a complete summary with all fields populated', async () => {
    const startedAt = new Date('2024-01-15T10:00:00Z');
    const endedAt = new Date('2024-01-15T11:30:00Z');

    mockState.sessionRows = [{ id: 'session-1', startedAt, endedAt, goal: 'Send V5' }];
    mockState.gradeDistRows = [
      { grade: 'V5', difficulty: 18, count: 3 },
      { grade: 'V4', difficulty: 16, count: 5 },
    ];
    mockState.hardestRows = [
      {
        climbUuid: 'climb-abc',
        boardType: 'kilter',
        difficulty: 18,
        grade: 'V5',
        climbName: 'The Crusher',
      },
    ];
    mockState.participantRows = [
      { userId: 'user-1', displayName: 'Alice', avatarUrl: null, sends: 4, attempts: 8 },
      {
        userId: 'user-2',
        displayName: 'Bob',
        avatarUrl: 'https://example.com/bob.jpg',
        sends: 2,
        attempts: 5,
      },
    ];

    const result = await generateSessionSummary('session-1');

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('session-1');
    expect(result!.totalSends).toBe(6);
    expect(result!.totalAttempts).toBe(13);
    expect(result!.durationMinutes).toBe(90);
    expect(result!.goal).toBe('Send V5');
    expect(result!.startedAt).toBe('2024-01-15T10:00:00.000Z');
    expect(result!.endedAt).toBe('2024-01-15T11:30:00.000Z');

    expect(result!.gradeDistribution).toEqual([
      { grade: 'V5', count: 3 },
      { grade: 'V4', count: 5 },
    ]);

    expect(result!.hardestClimb).toEqual({
      climbUuid: 'climb-abc',
      climbName: 'The Crusher',
      grade: 'V5',
    });

    expect(result!.participants).toHaveLength(2);
    expect(result!.participants[0]).toEqual({
      userId: 'user-1',
      displayName: 'Alice',
      avatarUrl: null,
      sends: 4,
      attempts: 8,
    });
    expect(result!.participants[1]).toEqual({
      userId: 'user-2',
      displayName: 'Bob',
      avatarUrl: 'https://example.com/bob.jpg',
      sends: 2,
      attempts: 5,
    });
  });

  it('filters out null grades in grade distribution', async () => {
    mockState.sessionRows = [{ id: 'session-1', startedAt: new Date(), endedAt: new Date(), goal: null }];
    mockState.gradeDistRows = [
      { grade: 'V3', difficulty: 14, count: 2 },
      { grade: null, difficulty: null, count: 1 },
      { grade: 'V5', difficulty: 18, count: 3 },
    ];
    mockState.hardestRows = [];
    mockState.participantRows = [];

    const result = await generateSessionSummary('session-1');

    expect(result!.gradeDistribution).toEqual([
      { grade: 'V3', count: 2 },
      { grade: 'V5', count: 3 },
    ]);
  });

  it('returns null duration when endedAt is missing', async () => {
    mockState.sessionRows = [{ id: 'session-1', startedAt: new Date(), endedAt: null, goal: null }];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [];
    mockState.participantRows = [];

    const result = await generateSessionSummary('session-1');

    expect(result!.durationMinutes).toBeNull();
  });

  it('returns null duration when startedAt is missing', async () => {
    mockState.sessionRows = [{ id: 'session-1', startedAt: null, endedAt: new Date(), goal: null }];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [];
    mockState.participantRows = [];

    const result = await generateSessionSummary('session-1');

    expect(result!.durationMinutes).toBeNull();
  });

  it('returns null hardestClimb when no sends exist', async () => {
    mockState.sessionRows = [{ id: 'session-1', startedAt: null, endedAt: null, goal: null }];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [];
    mockState.participantRows = [];

    const result = await generateSessionSummary('session-1');

    expect(result!.hardestClimb).toBeNull();
  });

  it('falls back to "Unknown climb" when climbName is null', async () => {
    mockState.sessionRows = [{ id: 'session-1', startedAt: null, endedAt: null, goal: null }];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [
      {
        climbUuid: 'climb-xyz',
        boardType: 'kilter',
        difficulty: 20,
        grade: 'V6',
        climbName: null,
      },
    ];
    mockState.participantRows = [];

    const result = await generateSessionSummary('session-1');

    expect(result!.hardestClimb!.climbName).toBe('Unknown climb');
  });

  it('falls back to V{difficulty} when grade is null on hardest climb', async () => {
    mockState.sessionRows = [{ id: 'session-1', startedAt: null, endedAt: null, goal: null }];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [
      {
        climbUuid: 'climb-xyz',
        boardType: 'kilter',
        difficulty: 20,
        grade: null,
        climbName: 'Mystery Route',
      },
    ];
    mockState.participantRows = [];

    const result = await generateSessionSummary('session-1');

    expect(result!.hardestClimb!.grade).toBe('V20');
  });

  it('returns zero totals when there are no participants', async () => {
    mockState.sessionRows = [{ id: 'session-1', startedAt: null, endedAt: null, goal: null }];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [];
    mockState.participantRows = [];

    const result = await generateSessionSummary('session-1');

    expect(result!.totalSends).toBe(0);
    expect(result!.totalAttempts).toBe(0);
    expect(result!.participants).toEqual([]);
  });

  it('returns null goal when session has no goal', async () => {
    mockState.sessionRows = [{ id: 'session-1', startedAt: null, endedAt: null, goal: null }];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [];
    mockState.participantRows = [];

    const result = await generateSessionSummary('session-1');

    expect(result!.goal).toBeNull();
  });

  it('returns null goal when session goal is empty string', async () => {
    mockState.sessionRows = [{ id: 'session-1', startedAt: null, endedAt: null, goal: '' }];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [];
    mockState.participantRows = [];

    const result = await generateSessionSummary('session-1');

    // '' is falsy, so `session.goal || null` returns null
    expect(result!.goal).toBeNull();
  });

  it('rounds duration to nearest minute', async () => {
    const startedAt = new Date('2024-01-15T10:00:00Z');
    const endedAt = new Date('2024-01-15T10:45:30Z'); // 45 min 30 sec

    mockState.sessionRows = [{ id: 'session-1', startedAt, endedAt, goal: null }];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [];
    mockState.participantRows = [];

    const result = await generateSessionSummary('session-1');

    // 45.5 minutes rounds to 46
    expect(result!.durationMinutes).toBe(46);
  });

  it('returns startedAt and endedAt as ISO strings', async () => {
    const startedAt = new Date('2024-06-15T14:30:00Z');
    const endedAt = new Date('2024-06-15T16:45:00Z');

    mockState.sessionRows = [{ id: 'session-1', startedAt, endedAt, goal: null }];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [];
    mockState.participantRows = [];

    const result = await generateSessionSummary('session-1');

    expect(result!.startedAt).toBe('2024-06-15T14:30:00.000Z');
    expect(result!.endedAt).toBe('2024-06-15T16:45:00.000Z');
  });

  it('returns null startedAt and endedAt when both are undefined', async () => {
    mockState.sessionRows = [{ id: 'session-1', startedAt: undefined, endedAt: undefined, goal: null }];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [];
    mockState.participantRows = [];

    const result = await generateSessionSummary('session-1');

    expect(result!.startedAt).toBeNull();
    expect(result!.endedAt).toBeNull();
  });

  it('correctly sums totals from multiple participants', async () => {
    mockState.sessionRows = [{ id: 'session-1', startedAt: null, endedAt: null, goal: null }];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [];
    mockState.participantRows = [
      { userId: 'user-1', displayName: 'A', avatarUrl: null, sends: 10, attempts: 15 },
      { userId: 'user-2', displayName: 'B', avatarUrl: null, sends: 5, attempts: 20 },
      { userId: 'user-3', displayName: 'C', avatarUrl: null, sends: 0, attempts: 3 },
    ];

    const result = await generateSessionSummary('session-1');

    expect(result!.totalSends).toBe(15);
    expect(result!.totalAttempts).toBe(38);
    expect(result!.participants).toHaveLength(3);
  });
});
