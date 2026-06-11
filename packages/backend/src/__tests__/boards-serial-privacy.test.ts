import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { socialBoardQueries, socialBoardMutations } from '../graphql/resolvers/social/boards';

// Mock db + dependencies before importing resolver.
// `vi.mock` is hoisted to the top of the file at parse time, so even though
// these calls appear textually below the resolver import, they execute first.
const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    execute: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  };
  return { mockDb };
});

vi.mock('../db/client', () => ({
  db: mockDb,
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn(),
}));

vi.mock('../events/index', () => ({
  publishSocialEvent: vi.fn().mockResolvedValue(undefined),
}));

// Minimal DB row matching the userBoards schema shape
function makeDbBoard(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: 'board-uuid-1',
    slug: 'my-board',
    ownerId: 'owner-123',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    name: 'Secret Home Wall',
    description: 'My private training cave',
    locationName: '123 Home Street',
    latitude: 40.7128,
    longitude: -74.006,
    isPublic: false,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: new Date('2025-01-01'),
    gymId: null,
    serialNumber: 'SERIAL001',
    deletedAt: null,
    ...overrides,
  };
}

function makeUnauthCtx(): ConnectionContext {
  return { connectionId: 'conn-1', isAuthenticated: false } as ConnectionContext;
}

function makeAuthCtx(userId = 'user-1'): ConnectionContext {
  return { connectionId: 'conn-1', isAuthenticated: true, userId } as ConnectionContext;
}

// Set up the mock chain for db.select().from().where() returning the given rows
function setupDbSelect(rows: unknown[]) {
  const mockWhere = vi.fn().mockResolvedValue(rows);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  mockDb.select.mockReturnValue({ from: mockFrom });
}

function setupDbSelectWithLimit(rows: unknown[]) {
  const terminal = Object.assign(Promise.resolve(rows), {
    limit: vi.fn().mockResolvedValue(rows),
  });
  const mockWhere = vi.fn().mockReturnValue(terminal);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  mockDb.select.mockReturnValue({ from: mockFrom });
}

// Set up multiple sequential select calls (for enrichBoards which does many queries).
// Each call to db.select().from()... resolves to the corresponding entry in `calls`.
function setupDbSelectSequence(calls: unknown[][]) {
  let callIndex = 0;

  mockDb.select.mockImplementation(() => {
    const currentIndex = callIndex++;
    const rows = calls[currentIndex] ?? [];

    // Build a chainable mock that supports .from().where(), .from().leftJoin().where(),
    // and .from().where().groupBy() — all resolving to `rows`.
    const limitResult = Object.assign(Promise.resolve(rows), {
      offset: vi.fn().mockResolvedValue(rows),
    });
    const terminal = Object.assign(Promise.resolve(rows), {
      groupBy: vi.fn().mockResolvedValue(rows),
      limit: vi.fn().mockReturnValue(limitResult),
    });
    const mockWhere = vi.fn().mockReturnValue(terminal);
    const mockLeftJoin = vi.fn().mockReturnValue({ where: mockWhere });
    const mockFrom = vi.fn().mockReturnValue({
      where: mockWhere,
      leftJoin: mockLeftJoin,
    });

    return { from: mockFrom };
  });
}

// Set up the mock chain for `db.select().from().leftJoin().where()` resolving to rows.
// `myBoardSerialConfigs` calls: select({...}).from(userBoardSerials).leftJoin(...).where(...)
// where the where(...) result is awaited directly (no .limit()/.groupBy()).
function setupDbLeftJoin(rows: unknown[]) {
  const terminal = Object.assign(Promise.resolve(rows), {
    groupBy: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockResolvedValue(rows),
  });
  const mockWhere = vi.fn().mockReturnValue(terminal);
  const mockLeftJoin = vi.fn().mockReturnValue({ where: mockWhere });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere, leftJoin: mockLeftJoin });
  mockDb.select.mockReturnValue({ from: mockFrom });
  return { mockWhere, mockLeftJoin, mockFrom };
}

describe('direct board lookup privacy', () => {
  const VALID_BOARD_UUID = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for defaultBoard when caller is anonymous and does no DB work', async () => {
    const result = await socialBoardQueries.defaultBoard(null, {}, makeUnauthCtx());

    expect(result).toBeNull();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('returns null for private direct UUID lookup when caller is anonymous', async () => {
    setupDbSelectWithLimit([makeDbBoard({ uuid: VALID_BOARD_UUID, isPublic: false, isUnlisted: false })]);

    const result = await socialBoardQueries.board(null, { boardUuid: VALID_BOARD_UUID }, makeUnauthCtx());

    expect(result).toBeNull();
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('returns null for unlisted direct UUID lookup when caller is anonymous', async () => {
    setupDbSelectWithLimit([makeDbBoard({ uuid: VALID_BOARD_UUID, isPublic: true, isUnlisted: true })]);

    const result = await socialBoardQueries.board(null, { boardUuid: VALID_BOARD_UUID }, makeUnauthCtx());

    expect(result).toBeNull();
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('returns public listed boards by UUID for anonymous callers', async () => {
    const publicBoard = makeDbBoard({
      uuid: VALID_BOARD_UUID,
      isPublic: true,
      isUnlisted: false,
      name: 'Public Gym Board',
      description: 'Open wall',
      locationName: 'Downtown Gym',
    });
    setupDbSelectSequence([
      [publicBoard],
      [{ userId: 'owner-123', name: 'Owner', image: null, displayName: 'The Owner', avatarUrl: null }],
      [{ totalAscents: 12, uniqueClimbers: 4 }],
      [{ count: 3 }],
      [{ count: 2 }],
    ]);

    const result = await socialBoardQueries.board(null, { boardUuid: VALID_BOARD_UUID }, makeUnauthCtx());

    expect(result).toMatchObject({
      uuid: VALID_BOARD_UUID,
      name: 'Public Gym Board',
      isPublic: true,
      isUnlisted: false,
      totalAscents: 12,
      uniqueClimbers: 4,
      followerCount: 3,
      commentCount: 2,
      isFollowedByMe: false,
    });
  });

  it('returns null for private direct slug lookup when caller is anonymous', async () => {
    setupDbSelectWithLimit([makeDbBoard({ slug: 'secret-board', isPublic: false, isUnlisted: false })]);

    const result = await socialBoardQueries.boardBySlug(null, { slug: 'secret-board' }, makeUnauthCtx());

    expect(result).toBeNull();
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('returns null for unlisted direct slug lookup when caller is anonymous', async () => {
    setupDbSelectWithLimit([makeDbBoard({ slug: 'hidden-board', isPublic: true, isUnlisted: true })]);

    const result = await socialBoardQueries.boardBySlug(null, { slug: 'hidden-board' }, makeUnauthCtx());

    expect(result).toBeNull();
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('keeps authenticated direct UUID lookup behavior unchanged', async () => {
    const privateBoard = makeDbBoard({ uuid: VALID_BOARD_UUID, isPublic: false, isUnlisted: true });
    setupDbSelectSequence([
      [privateBoard],
      [{ userId: 'owner-123', name: 'Owner', image: null, displayName: 'The Owner', avatarUrl: null }],
      [{ totalAscents: 1, uniqueClimbers: 1 }],
      [{ count: 0 }],
      [{ count: 0 }],
      [{ count: 1 }],
    ]);

    const result = await socialBoardQueries.board(null, { boardUuid: VALID_BOARD_UUID }, makeAuthCtx('user-1'));

    expect(result).toMatchObject({
      uuid: VALID_BOARD_UUID,
      name: 'Secret Home Wall',
      isPublic: false,
      isUnlisted: true,
      isFollowedByMe: true,
    });
  });
});

describe('boardsBySerialNumbers privacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('unauthenticated callers', () => {
    it('strips name, description, and locationName from non-public boards', async () => {
      const privateBoard = makeDbBoard({
        isPublic: false,
        name: 'Secret Wall',
        description: 'Hidden',
        locationName: 'Home',
      });
      setupDbSelect([privateBoard]);

      const results = await socialBoardQueries.boardsBySerialNumbers(
        null,
        { serialNumbers: ['SERIAL001'] },
        makeUnauthCtx(),
      );

      expect(results).toHaveLength(1);
      const board = results[0];
      // Name falls back to boardType for non-public boards
      expect(board.name).toBe('kilter');
      expect(board.description).toBeNull();
      expect(board.locationName).toBeNull();
    });

    it('strips name, description, and locationName from unlisted boards', async () => {
      const unlistedBoard = makeDbBoard({
        isPublic: false,
        isUnlisted: true,
        name: 'Hidden Wall',
        description: 'Not discoverable',
        locationName: 'Secret Location',
      });
      setupDbSelect([unlistedBoard]);

      const results = await socialBoardQueries.boardsBySerialNumbers(
        null,
        { serialNumbers: ['SERIAL001'] },
        makeUnauthCtx(),
      );

      expect(results).toHaveLength(1);
      const board = results[0];
      expect(board.name).toBe('kilter');
      expect(board.description).toBeNull();
      expect(board.locationName).toBeNull();
      expect(board.isUnlisted).toBe(true);
    });

    it('includes name, description, and locationName for public boards', async () => {
      const publicBoard = makeDbBoard({
        isPublic: true,
        name: 'Gym Wall',
        description: 'Open to all',
        locationName: 'Downtown Gym',
      });
      setupDbSelect([publicBoard]);

      const results = await socialBoardQueries.boardsBySerialNumbers(
        null,
        { serialNumbers: ['SERIAL001'] },
        makeUnauthCtx(),
      );

      expect(results).toHaveLength(1);
      const board = results[0];
      expect(board.name).toBe('Gym Wall');
      expect(board.description).toBe('Open to all');
      expect(board.locationName).toBe('Downtown Gym');
    });

    it('always strips GPS, owner identity, and stats', async () => {
      const publicBoard = makeDbBoard({
        isPublic: true,
        latitude: 40.7128,
        longitude: -74.006,
        ownerId: 'owner-secret',
      });
      setupDbSelect([publicBoard]);

      const results = await socialBoardQueries.boardsBySerialNumbers(
        null,
        { serialNumbers: ['SERIAL001'] },
        makeUnauthCtx(),
      );

      const board = results[0];
      expect(board.latitude).toBeNull();
      expect(board.longitude).toBeNull();
      expect(board.ownerId).toBe('');
      expect(board.ownerDisplayName).toBeNull();
      expect(board.ownerAvatarUrl).toBeNull();
      expect(board.totalAscents).toBe(0);
      expect(board.uniqueClimbers).toBe(0);
      expect(board.followerCount).toBe(0);
      expect(board.commentCount).toBe(0);
      expect(board.isFollowedByMe).toBe(false);
    });

    it('returns board configuration fields for all boards', async () => {
      const board = makeDbBoard({ isPublic: false, serialNumber: 'SN42' });
      setupDbSelect([board]);

      const results = await socialBoardQueries.boardsBySerialNumbers(
        null,
        { serialNumbers: ['SN42'] },
        makeUnauthCtx(),
      );

      const result = results[0];
      expect(result.uuid).toBe('board-uuid-1');
      expect(result.slug).toBe('my-board');
      expect(result.boardType).toBe('kilter');
      expect(result.layoutId).toBe(1);
      expect(result.sizeId).toBe(10);
      expect(result.setIds).toBe('1,2');
      expect(result.angle).toBe(40);
      expect(result.serialNumber).toBe('SN42');
      expect(result.isPublic).toBe(false);
      expect(result.isUnlisted).toBe(false);
    });

    it('returns all non-null UserBoard fields with valid defaults', async () => {
      const board = makeDbBoard({ isPublic: false });
      setupDbSelect([board]);

      const results = await socialBoardQueries.boardsBySerialNumbers(
        null,
        { serialNumbers: ['SERIAL001'] },
        makeUnauthCtx(),
      );

      const result = results[0];
      // Verify every non-null field in the GraphQL schema is present
      expect(result.uuid).toBeDefined();
      expect(result.slug).toBeDefined();
      expect(typeof result.ownerId).toBe('string');
      expect(typeof result.boardType).toBe('string');
      expect(typeof result.layoutId).toBe('number');
      expect(typeof result.sizeId).toBe('number');
      expect(typeof result.setIds).toBe('string');
      expect(typeof result.name).toBe('string');
      expect(typeof result.isPublic).toBe('boolean');
      expect(typeof result.isUnlisted).toBe('boolean');
      expect(typeof result.hideLocation).toBe('boolean');
      expect(typeof result.isOwned).toBe('boolean');
      expect(typeof result.angle).toBe('number');
      expect(typeof result.isAngleAdjustable).toBe('boolean');
      expect(typeof result.createdAt).toBe('string');
      expect(typeof result.totalAscents).toBe('number');
      expect(typeof result.uniqueClimbers).toBe('number');
      expect(typeof result.followerCount).toBe('number');
      expect(typeof result.commentCount).toBe('number');
      expect(typeof result.isFollowedByMe).toBe('boolean');
    });

    it('does not call enrichBoards (no owner/stats queries)', async () => {
      setupDbSelect([makeDbBoard()]);

      await socialBoardQueries.boardsBySerialNumbers(null, { serialNumbers: ['SERIAL001'] }, makeUnauthCtx());

      // Only one select call: the board lookup itself.
      // enrichBoards would trigger 6+ additional select calls.
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('authenticated callers', () => {
    it('returns full board data including owner and stats', async () => {
      const board = makeDbBoard({
        isPublic: false,
        name: 'Secret Wall',
        description: 'Private',
        locationName: 'Home',
        latitude: 40.7128,
        longitude: -74.006,
      });

      // First call: board lookup; remaining calls: enrichBoards queries
      setupDbSelectSequence([
        [board], // board lookup
        [{ userId: 'owner-123', name: 'Owner', image: null, displayName: 'The Owner', avatarUrl: null }], // owner
        [{ boardId: 1, totalAscents: 42, uniqueClimbers: 10 }], // ticks
        [{ boardUuid: 'board-uuid-1', count: 5 }], // followers
        [{ entityId: 'board-uuid-1', count: 3 }], // comments
        [{ boardUuid: 'board-uuid-1' }], // follow status
        [], // gyms
      ]);

      const results = await socialBoardQueries.boardsBySerialNumbers(
        null,
        { serialNumbers: ['SERIAL001'] },
        makeAuthCtx('user-1'),
      );

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.name).toBe('Secret Wall');
      expect(result.description).toBe('Private');
      expect(result.locationName).toBe('Home');
      expect(result.latitude).toBe(40.7128);
      expect(result.longitude).toBe(-74.006);
      expect(result.ownerDisplayName).toBe('The Owner');
      expect(result.totalAscents).toBe(42);
      expect(result.uniqueClimbers).toBe(10);
    });
  });
});

describe('myBoardSerialConfigs privacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRecording(overrides: Record<string, unknown> = {}) {
    return {
      serialNumber: 'SERIAL001',
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      apiLevel: 3,
      updatedAt: new Date('2026-04-01'),
      boardUuid: null,
      boardSlug: null,
      ...overrides,
    };
  }

  it('throws when caller is not authenticated', async () => {
    setupDbLeftJoin([]);

    await expect(
      socialBoardQueries.myBoardSerialConfigs(null, { serialNumbers: ['SERIAL001'] }, makeUnauthCtx()),
    ).rejects.toThrow(/Authentication required/);

    // Must short-circuit before any DB call.
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('rejects empty/whitespace-only serials at validation', async () => {
    setupDbLeftJoin([]);

    await expect(
      socialBoardQueries.myBoardSerialConfigs(null, { serialNumbers: ['', '   '] }, makeAuthCtx('user-1')),
    ).rejects.toThrow();

    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('returns empty array when the input array is empty', async () => {
    setupDbLeftJoin([]);

    const results = await socialBoardQueries.myBoardSerialConfigs(null, { serialNumbers: [] }, makeAuthCtx('user-1'));

    expect(results).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('queries the DB and returns mapped recordings for the calling user', async () => {
    const recording = makeRecording({
      serialNumber: 'SN42',
      boardName: 'tension',
      layoutId: 5,
      sizeId: 12,
      setIds: '1,3',
      boardUuid: 'linked-board-uuid',
      boardSlug: 'my-tension',
    });
    setupDbLeftJoin([recording]);

    const results = await socialBoardQueries.myBoardSerialConfigs(
      null,
      { serialNumbers: ['SN42'] },
      makeAuthCtx('user-1'),
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      serialNumber: 'SN42',
      boardName: 'tension',
      layoutId: 5,
      sizeId: 12,
      setIds: '1,3',
      apiLevel: 3,
      updatedAt: '2026-04-01T00:00:00.000Z',
      boardUuid: 'linked-board-uuid',
      boardSlug: 'my-tension',
    });
    // Single DB call — the resolver does not enrich beyond the leftJoin.
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('does not return recordings belonging to other users (DB filter is the boundary)', async () => {
    // Simulate the WHERE clause filtering correctly: when called as user-1,
    // the DB only returns user-1's rows. user-2's row is invisible to user-1
    // and would never appear in the result set.
    const userOneRecording = makeRecording({ serialNumber: 'SHARED-SERIAL' });
    setupDbLeftJoin([userOneRecording]);

    const userOneResults = await socialBoardQueries.myBoardSerialConfigs(
      null,
      { serialNumbers: ['SHARED-SERIAL'] },
      makeAuthCtx('user-1'),
    );

    expect(userOneResults).toHaveLength(1);
    expect(userOneResults[0].serialNumber).toBe('SHARED-SERIAL');

    // Now simulate the same query as user-2: DB returns nothing because
    // user-2 has no recording for that serial. User-2 cannot see user-1's row.
    vi.clearAllMocks();
    setupDbLeftJoin([]);

    const userTwoResults = await socialBoardQueries.myBoardSerialConfigs(
      null,
      { serialNumbers: ['SHARED-SERIAL'] },
      makeAuthCtx('user-2'),
    );

    expect(userTwoResults).toEqual([]);
  });

  it('rejects input with more than 20 serials (Zod validation)', async () => {
    setupDbLeftJoin([]);

    const twentyFiveSerials = Array.from({ length: 25 }, (_, i) => `SN${i}`);
    await expect(
      socialBoardQueries.myBoardSerialConfigs(null, { serialNumbers: twentyFiveSerials }, makeAuthCtx('user-1')),
    ).rejects.toThrow();

    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('rejects input with a serial longer than 64 chars', async () => {
    setupDbLeftJoin([]);

    await expect(
      socialBoardQueries.myBoardSerialConfigs(null, { serialNumbers: ['A'.repeat(65)] }, makeAuthCtx('user-1')),
    ).rejects.toThrow();

    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('handles a recording with no linked board (boardUuid + boardSlug both null)', async () => {
    setupDbLeftJoin([makeRecording({ boardUuid: null, boardSlug: null })]);

    const results = await socialBoardQueries.myBoardSerialConfigs(
      null,
      { serialNumbers: ['SERIAL001'] },
      makeAuthCtx('user-1'),
    );

    expect(results[0].boardUuid).toBeNull();
    expect(results[0].boardSlug).toBeNull();
  });

  it('returns boardSlug=null when the linked board is soft-deleted (leftJoin excludes it)', async () => {
    // The resolver's leftJoin filters by `isNull(userBoards.deletedAt)`. When
    // the linked board has been soft-deleted, the join condition fails and
    // userBoards.slug comes back as null, even though the recording row still
    // carries its original boardUuid pointer. The recording stays usable as a
    // fallback (config is intact), it just loses the saved-board linkage.
    const orphanedRecording = makeRecording({
      boardUuid: 'deleted-board-uuid',
      boardSlug: null,
    });
    setupDbLeftJoin([orphanedRecording]);

    const results = await socialBoardQueries.myBoardSerialConfigs(
      null,
      { serialNumbers: ['SERIAL001'] },
      makeAuthCtx('user-1'),
    );

    expect(results[0].boardUuid).toBe('deleted-board-uuid');
    expect(results[0].boardSlug).toBeNull();
  });
});

describe('recordBoardSerial', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Wires the two sequential selects the mutation runs (saved-board lookup, then
  // the post-upsert re-select) plus the insert().values().onConflictDoUpdate()
  // chain. boardUuid is omitted so there's no intermediate ownership select.
  function setupRecord({ savedMatch = [], recordingRow }: { savedMatch?: unknown[]; recordingRow: unknown }) {
    let selectCall = 0;
    mockDb.select.mockImplementation(() => {
      const rows = selectCall++ === 0 ? savedMatch : [recordingRow];
      const limit = vi.fn().mockResolvedValue(rows);
      const where = vi.fn().mockReturnValue({ limit });
      const leftJoin = vi.fn().mockReturnValue({ where });
      const from = vi.fn().mockReturnValue({ where, leftJoin });
      return { from };
    });
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    mockDb.insert.mockReturnValue({ values });
    return { values, onConflictDoUpdate };
  }

  function recordingRow(overrides: Record<string, unknown> = {}) {
    return {
      serialNumber: 'SN42',
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      apiLevel: 3,
      updatedAt: new Date('2026-04-01'),
      boardUuid: null,
      boardSlug: null,
      ...overrides,
    };
  }

  it('throws when the caller is not authenticated', async () => {
    await expect(
      socialBoardMutations.recordBoardSerial(
        null,
        { input: { serialNumber: 'SN42', boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', apiLevel: 3 } },
        makeUnauthCtx(),
      ),
    ).rejects.toThrow(/Authentication required/);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('upserts the recording with its API level and returns the stored config', async () => {
    const { values } = setupRecord({ savedMatch: [], recordingRow: recordingRow() });

    const result = await socialBoardMutations.recordBoardSerial(
      null,
      { input: { serialNumber: 'SN42', boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', apiLevel: 3 } },
      makeAuthCtx('user-1'),
    );

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ apiLevel: 3, serialNumber: 'SN42' }));
    expect(result).toEqual(
      expect.objectContaining({ serialNumber: 'SN42', apiLevel: 3, updatedAt: '2026-04-01T00:00:00.000Z' }),
    );
  });

  it('persists a null API level when none is supplied', async () => {
    const { values } = setupRecord({ savedMatch: [], recordingRow: recordingRow({ apiLevel: null }) });

    const result = await socialBoardMutations.recordBoardSerial(
      null,
      { input: { serialNumber: 'SN42', boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' } },
      makeAuthCtx('user-1'),
    );

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ apiLevel: null }));
    expect(result?.apiLevel).toBeNull();
  });

  it('skips the write and returns null when a saved board already matches', async () => {
    const { values } = setupRecord({
      savedMatch: [{ boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '2,1' }],
      recordingRow: recordingRow(),
    });

    const result = await socialBoardMutations.recordBoardSerial(
      null,
      { input: { serialNumber: 'SN42', boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', apiLevel: 3 } },
      makeAuthCtx('user-1'),
    );

    expect(result).toBeNull();
    expect(values).not.toHaveBeenCalled();
  });

  it('rejects set IDs that are not a comma-separated integer list', async () => {
    setupRecord({ savedMatch: [], recordingRow: recordingRow() });

    await expect(
      socialBoardMutations.recordBoardSerial(
        null,
        { input: { serialNumber: 'SN42', boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1, 2,', apiLevel: 3 } },
        makeAuthCtx('user-1'),
      ),
    ).rejects.toThrow();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  // Wires an arbitrary sequence of select() results. Supplying a boardUuid adds
  // an intermediate ownership select, so these tests model all three queries in
  // order: saved-board lookup → ownership check → post-upsert re-select.
  function setupRecordSeq(selectResults: unknown[][]) {
    let selectCall = 0;
    mockDb.select.mockImplementation(() => {
      const rows = selectResults[selectCall++] ?? [];
      const limit = vi.fn().mockResolvedValue(rows);
      const where = vi.fn().mockReturnValue({ limit });
      const leftJoin = vi.fn().mockReturnValue({ where });
      const from = vi.fn().mockReturnValue({ where, leftJoin });
      return { from };
    });
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    mockDb.insert.mockReturnValue({ values });
    return { values };
  }

  // Saved-board uuids are RFC 4122 (the input schema validates strictly), so the
  // ownership tests use real UUIDs rather than placeholder strings.
  const FORGED_UUID = '11111111-1111-4111-8111-111111111111';
  const OWNED_UUID = '22222222-2222-4222-8222-222222222222';

  it('drops a forged boardUuid (not owned by the caller and not public) to null', async () => {
    // saved lookup: no match → proceeds to write
    // ownership check: empty → uuid is neither owned-by-caller nor public
    // re-select: row with no linked board
    const { values } = setupRecordSeq([[], [], [recordingRow({ boardUuid: null, boardSlug: null })]]);

    const result = await socialBoardMutations.recordBoardSerial(
      null,
      {
        input: {
          serialNumber: 'SN42',
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,2',
          apiLevel: 3,
          boardUuid: FORGED_UUID,
        },
      },
      makeAuthCtx('user-1'),
    );

    // The security property: a uuid the caller can't reach is never persisted as
    // a link — it silently becomes null so the controller can't be attached to
    // another user's private board.
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ boardUuid: null }));
    expect(result?.boardUuid).toBeNull();
  });

  it('links a boardUuid the caller is allowed to reach', async () => {
    // ownership check returns a row → uuid is owned-by-caller or public
    const { values } = setupRecordSeq([
      [],
      [{ uuid: OWNED_UUID }],
      [recordingRow({ boardUuid: OWNED_UUID, boardSlug: 'my-board' })],
    ]);

    const result = await socialBoardMutations.recordBoardSerial(
      null,
      {
        input: {
          serialNumber: 'SN42',
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,2',
          apiLevel: 3,
          boardUuid: OWNED_UUID,
        },
      },
      makeAuthCtx('user-1'),
    );

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ boardUuid: OWNED_UUID }));
    expect(result?.boardUuid).toBe(OWNED_UUID);
    expect(result?.boardSlug).toBe('my-board');
  });
});
