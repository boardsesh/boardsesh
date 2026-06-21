import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { generateSessionHealthExport, generateSessionSummary } from '../graphql/resolvers/sessions/session-summary';

// Shared mock state, declared with vi.hoisted to ensure availability before mock setup
const mockState = vi.hoisted(() => ({
  selectCallIndex: 0,
  sessionRows: [] as Record<string, unknown>[],
  gradeDistRows: [] as Record<string, unknown>[],
  hardestRows: [] as Record<string, unknown>[],
  participantRows: [] as Record<string, unknown>[],
  getSessionHealthExport: vi.fn(),
}));

// Chainable mock builder, also hoisted for use in mock factory
const { createChainableMock } = vi.hoisted(() => ({
  createChainableMock: (resolveData: unknown) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'from', 'where', 'leftJoin', 'groupBy', 'orderBy', 'limit']) {
      chain[method] = (..._args: unknown[]) => chain;
    }
    // oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are thenable, so this mock mirrors that contract.
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
          return (..._args: unknown[]) => {
            const index = mockState.selectCallIndex++;
            const dataByIndex = [mockState.sessionRows, mockState.gradeDistRows, mockState.hardestRows];
            return createChainableMock(dataByIndex[index] ?? []);
          };
        }
        if (prop === 'execute') {
          return (..._args: unknown[]) => Promise.resolve(mockState.participantRows);
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
  boardClimbAliases: {},
}));

vi.mock('@boardsesh/db/queries', () => ({
  getSessionHealthExport: mockState.getSessionHealthExport,
}));

// Mock drizzle-orm functions to prevent errors from passing mock schema objects
vi.mock('drizzle-orm', () => ({
  eq: (..._args: unknown[]) => ({}),
  and: (..._args: unknown[]) => ({}),
  inArray: (..._args: unknown[]) => ({}),
  sql: (_strings: TemplateStringsArray, ..._values: unknown[]) => ({}),
  count: (..._args: unknown[]) => ({}),
  desc: (..._args: unknown[]) => ({}),
  isNotNull: (..._args: unknown[]) => ({}),
}));

describe('generateSessionSummary', () => {
  beforeEach(() => {
    mockState.selectCallIndex = 0;
    mockState.sessionRows = [];
    mockState.gradeDistRows = [];
    mockState.hardestRows = [];
    mockState.participantRows = [];
    mockState.getSessionHealthExport.mockReset();
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
      { grade: 'V5', difficulty: 18, flash: 1, send: 2, attempt: 0 },
      { grade: 'V4', difficulty: 16, flash: 0, send: 5, attempt: 2 },
    ];
    mockState.hardestRows = [
      {
        climbUuid: 'climb-abc',
        boardType: 'kilter',
        difficulty: 18,
        grade: 'V5',
        climbName: 'The Crusher',
        frames: 'p1145r15p1146r12',
        layoutId: 1,
        isMirror: false,
      },
    ];
    mockState.participantRows = [
      { userId: 'user-1', displayName: 'Alice', avatarUrl: null, sends: 4, flashes: 1, attempts: 8 },
      {
        userId: 'user-2',
        displayName: 'Bob',
        avatarUrl: 'https://example.com/bob.jpg',
        sends: 2,
        flashes: 0,
        attempts: 5,
      },
    ];

    const result = await generateSessionSummary('session-1');

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('session-1');
    expect(result!.totalSends).toBe(6);
    expect(result!.totalFlashes).toBe(1);
    expect(result!.totalAttempts).toBe(13);
    expect(result!.durationMinutes).toBe(90);
    expect(result!.goal).toBe('Send V5');
    expect(result!.startedAt).toBe('2024-01-15T10:00:00.000Z');
    expect(result!.endedAt).toBe('2024-01-15T11:30:00.000Z');

    expect(result!.gradeDistribution).toEqual([
      { grade: 'V5', count: 3, flash: 1, send: 2, attempt: 0 },
      { grade: 'V4', count: 5, flash: 0, send: 5, attempt: 2 },
    ]);

    expect(result!.hardestClimb).toEqual({
      climbUuid: 'climb-abc',
      climbName: 'The Crusher',
      grade: 'V5',
      frames: 'p1145r15p1146r12',
      layoutId: 1,
      boardType: 'kilter',
      isMirror: false,
    });

    expect(result!.participants).toHaveLength(2);
    expect(result!.participants[0]).toEqual({
      userId: 'user-1',
      displayName: 'Alice',
      avatarUrl: null,
      sends: 4,
      flashes: 1,
      attempts: 8,
    });
    expect(result!.participants[1]).toEqual({
      userId: 'user-2',
      displayName: 'Bob',
      avatarUrl: 'https://example.com/bob.jpg',
      sends: 2,
      flashes: 0,
      attempts: 5,
    });
  });

  it('filters out null grades in grade distribution', async () => {
    mockState.sessionRows = [{ id: 'session-1', startedAt: new Date(), endedAt: new Date(), goal: null }];
    mockState.gradeDistRows = [
      { grade: 'V3', difficulty: 14, flash: 0, send: 2, attempt: 0 },
      { grade: null, difficulty: null, flash: 0, send: 1, attempt: 0 },
      { grade: 'V5', difficulty: 18, flash: 1, send: 2, attempt: 0 },
    ];
    mockState.hardestRows = [];
    mockState.participantRows = [];

    const result = await generateSessionSummary('session-1');

    expect(result!.gradeDistribution).toEqual([
      { grade: 'V3', count: 2, flash: 0, send: 2, attempt: 0 },
      { grade: 'V5', count: 3, flash: 1, send: 2, attempt: 0 },
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
      { userId: 'user-1', displayName: 'A', avatarUrl: null, sends: 10, flashes: 3, attempts: 15 },
      { userId: 'user-2', displayName: 'B', avatarUrl: null, sends: 5, flashes: 1, attempts: 20 },
      { userId: 'user-3', displayName: 'C', avatarUrl: null, sends: 0, flashes: 0, attempts: 3 },
    ];

    const result = await generateSessionSummary('session-1');

    expect(result!.totalSends).toBe(15);
    expect(result!.totalFlashes).toBe(4);
    expect(result!.totalAttempts).toBe(38);
    expect(result!.participants).toHaveLength(3);
  });
});

describe('generateSessionHealthExport', () => {
  beforeEach(() => {
    mockState.getSessionHealthExport.mockReset();
  });

  it('returns null when the export read model is missing', async () => {
    mockState.getSessionHealthExport.mockResolvedValueOnce(null);

    await expect(generateSessionHealthExport('missing-session', 'user-1')).resolves.toBeNull();
  });

  it('returns null for a viewer who neither created nor ticked in the session', async () => {
    mockState.getSessionHealthExport.mockResolvedValueOnce({
      sessionId: 'session-1',
      createdByUserId: 'owner-user',
      startedAt: '2026-06-01T10:00:00.000Z',
      endedAt: '2026-06-01T11:00:00.000Z',
      durationMinutes: 60,
      boardType: 'kilter',
      totalSends: 0,
      totalAttempts: 0,
      hardestClimb: null,
      laps: [],
      healthKitWorkoutId: null,
    });

    await expect(generateSessionHealthExport('session-1', 'other-user')).resolves.toBeNull();
  });

  it('allows the session creator before they have ticks', async () => {
    mockState.getSessionHealthExport.mockResolvedValueOnce({
      sessionId: 'session-1',
      createdByUserId: 'creator-user',
      startedAt: '2026-06-01T10:00:00.000Z',
      endedAt: '2026-06-01T11:00:00.000Z',
      durationMinutes: 60,
      boardType: 'kilter',
      totalSends: 0,
      totalAttempts: 0,
      hardestClimb: null,
      laps: [],
      healthKitWorkoutId: null,
    });

    await expect(generateSessionHealthExport('session-1', 'creator-user')).resolves.toMatchObject({
      sessionId: 'session-1',
      boardType: 'kilter',
      totalSends: 0,
      totalAttempts: 0,
      laps: [],
      healthKitWorkoutId: null,
    });
  });

  it('returns only the viewer-owned export record', async () => {
    mockState.getSessionHealthExport.mockResolvedValueOnce({
      sessionId: 'session-1',
      createdByUserId: 'owner-user',
      startedAt: '2026-06-01T10:00:00.000Z',
      endedAt: '2026-06-01T11:00:00.000Z',
      durationMinutes: 60,
      boardType: 'kilter',
      totalSends: 1,
      totalAttempts: 3,
      hardestClimb: { climbUuid: 'climb-1', climbName: 'Test Climb', grade: 'V5' },
      laps: [
        {
          tickUuid: 'tick-1',
          climbUuid: 'climb-1',
          climbName: 'Test Climb',
          grade: 'V5',
          status: 'send',
          attemptCount: 3,
          boardType: 'kilter',
          angle: 40,
          climbedAt: '2026-06-01T10:20:00.000Z',
        },
      ],
      healthKitWorkoutId: 'healthkit-workout-1',
    });

    await expect(generateSessionHealthExport('session-1', 'participant-user')).resolves.toEqual({
      sessionId: 'session-1',
      startedAt: '2026-06-01T10:00:00.000Z',
      endedAt: '2026-06-01T11:00:00.000Z',
      durationMinutes: 60,
      boardType: 'kilter',
      totalSends: 1,
      totalAttempts: 3,
      hardestClimb: { climbUuid: 'climb-1', climbName: 'Test Climb', grade: 'V5' },
      laps: [
        {
          tickUuid: 'tick-1',
          climbUuid: 'climb-1',
          climbName: 'Test Climb',
          grade: 'V5',
          status: 'send',
          attemptCount: 3,
          boardType: 'kilter',
          angle: 40,
          climbedAt: '2026-06-01T10:20:00.000Z',
        },
      ],
      healthKitWorkoutId: 'healthkit-workout-1',
    });
  });
});
