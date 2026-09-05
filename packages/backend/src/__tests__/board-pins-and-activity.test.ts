import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';

/**
 * Render a Drizzle SQL fragment to its real SQL text. Asserting on the rendered
 * statement rather than on a marker string is the difference between proving the
 * upsert keeps the old value and proving only that someone typed the word.
 */
const dialect = new PgDialect();
function renderSql(fragment: unknown): string {
  return dialect.sqlToQuery(fragment as SQL).sql;
}

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    execute: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };
  return { mockDb };
});

vi.mock('../db/client', () => ({
  db: mockDb,
}));

vi.mock('../events/index', () => ({
  publishSocialEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn(),
}));

const BOARD_UUID = '11111111-1111-4111-8111-111111111111';

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: true,
    userId: 'user-123',
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

/** Drizzle-shaped chain mock — same helper shape as pinned-playlists.test.ts. */
function createMockChain(resolveValue: unknown = []) {
  const calls: Record<string, unknown[][]> = {};
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'leftJoin',
    'innerJoin',
    'groupBy',
    'orderBy',
    'limit',
    'offset',
    'insert',
    'values',
    'onConflictDoNothing',
    'onConflictDoUpdate',
    'returning',
    'delete',
    'update',
    'set',
  ];

  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolveValue).then(resolve);

  for (const method of methods) {
    calls[method] = [];
    chain[method] = vi.fn((...args: unknown[]) => {
      calls[method].push(args);
      return chain;
    });
  }

  return { chain, calls };
}

/** The board-exists lookup every one of these mutations does first. */
function mockBoardLookup(found: boolean) {
  const { chain } = createMockChain(found ? [{ uuid: BOARD_UUID }] : []);
  mockDb.select.mockReturnValueOnce(chain);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pinBoard', () => {
  it('rejects unauthenticated callers', async () => {
    const ctx = makeCtx({ isAuthenticated: false, userId: undefined });
    await expect(socialBoardMutations.pinBoard(null, { input: { boardUuid: BOARD_UUID } }, ctx)).rejects.toThrow(
      'Authentication required',
    );
  });

  it('rejects a malformed board uuid before touching the database', async () => {
    const ctx = makeCtx();
    await expect(socialBoardMutations.pinBoard(null, { input: { boardUuid: 'not-a-uuid' } }, ctx)).rejects.toThrow();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('rejects a board that does not exist or is soft-deleted', async () => {
    const ctx = makeCtx();
    mockBoardLookup(false);
    await expect(socialBoardMutations.pinBoard(null, { input: { boardUuid: BOARD_UUID } }, ctx)).rejects.toThrow(
      'Board not found',
    );
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('keeps the original pin time on conflict, so re-pinning does not reshuffle', async () => {
    const ctx = makeCtx();
    mockBoardLookup(true);
    const { chain, calls } = createMockChain([]);
    mockDb.insert.mockReturnValueOnce(chain);

    await expect(socialBoardMutations.pinBoard(null, { input: { boardUuid: BOARD_UUID } }, ctx)).resolves.toBe(true);

    const [conflictArg] = calls.onConflictDoUpdate[0] as [{ set: Record<string, unknown> }];
    // The rendered statement must read the existing pin back, not stamp now().
    expect(renderSql(conflictArg.set.pinnedAt)).toBe('COALESCE("user_board_activity"."pinned_at", now())');
    // lastUsedAt must not be clobbered by a pin.
    expect(conflictArg.set).not.toHaveProperty('lastUsedAt');
  });
});

describe('unpinBoard', () => {
  it('rejects unauthenticated callers', async () => {
    const ctx = makeCtx({ isAuthenticated: false, userId: undefined });
    await expect(socialBoardMutations.unpinBoard(null, { input: { boardUuid: BOARD_UUID } }, ctx)).rejects.toThrow(
      'Authentication required',
    );
  });

  it('is idempotent — an unpinned or unknown board still returns true', async () => {
    const ctx = makeCtx();
    const { chain } = createMockChain([]);
    mockDb.update.mockReturnValueOnce(chain);

    await expect(socialBoardMutations.unpinBoard(null, { input: { boardUuid: BOARD_UUID } }, ctx)).resolves.toBe(true);
  });

  it('clears the pin without deleting the row, so last-used survives', async () => {
    const ctx = makeCtx();
    const { chain, calls } = createMockChain([]);
    mockDb.update.mockReturnValueOnce(chain);

    await socialBoardMutations.unpinBoard(null, { input: { boardUuid: BOARD_UUID } }, ctx);

    const [setArg] = calls.set[0] as [Record<string, unknown>];
    expect(setArg.pinnedAt).toBeNull();
    expect(setArg).not.toHaveProperty('lastUsedAt');
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});

describe('recordBoardOpened', () => {
  it('rejects unauthenticated callers', async () => {
    const ctx = makeCtx({ isAuthenticated: false, userId: undefined });
    await expect(
      socialBoardMutations.recordBoardOpened(null, { input: { boardUuid: BOARD_UUID } }, ctx),
    ).rejects.toThrow('Authentication required');
  });

  it('records a board the caller neither owns nor follows', async () => {
    // The whole point: the client fires this the moment the active board
    // changes, which is BEFORE useActivateBoard's fire-and-forget follow lands.
    // An owns-or-follows gate would reject the first open of a board found over
    // BLE or a deep link, and that board would then sort last as "never used".
    const ctx = makeCtx();
    mockBoardLookup(true);
    const { chain } = createMockChain([]);
    mockDb.insert.mockReturnValueOnce(chain);

    await expect(socialBoardMutations.recordBoardOpened(null, { input: { boardUuid: BOARD_UUID } }, ctx)).resolves.toBe(
      true,
    );
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it('rejects a board that does not exist or is soft-deleted', async () => {
    const ctx = makeCtx();
    mockBoardLookup(false);
    await expect(
      socialBoardMutations.recordBoardOpened(null, { input: { boardUuid: BOARD_UUID } }, ctx),
    ).rejects.toThrow('Board not found');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('never moves the stored timestamp backwards, and never touches the pin', async () => {
    const ctx = makeCtx();
    mockBoardLookup(true);
    const { chain, calls } = createMockChain([]);
    mockDb.insert.mockReturnValueOnce(chain);

    await socialBoardMutations.recordBoardOpened(null, { input: { boardUuid: BOARD_UUID } }, ctx);

    const [conflictArg] = calls.onConflictDoUpdate[0] as [{ set: Record<string, unknown> }];
    // GREATEST(existing, incoming) — a delayed or replayed call cannot drag the
    // timestamp backwards.
    expect(renderSql(conflictArg.set.lastUsedAt)).toBe(
      'GREATEST("user_board_activity"."last_used_at", excluded.last_used_at)',
    );
    expect(conflictArg.set).not.toHaveProperty('pinnedAt');
  });
});
