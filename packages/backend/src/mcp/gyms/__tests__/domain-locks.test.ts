import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName, type SQL, type Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

interface QueryRecord {
  table?: string;
  predicate?: SQL;
  order?: unknown[];
  limit?: number;
  lock?: string;
  lockOptions?: { noWait?: boolean };
}

const state = vi.hoisted(() => ({
  select: vi.fn(),
  resolveGym: vi.fn(),
  canSeeGym: vi.fn(),
  requireGymEdit: vi.fn(),
  sharedEdit: undefined as typeof import('../../../graphql/resolvers/social/gyms').userCanEditGym | undefined,
  canReadBoard: vi.fn(),
  records: [] as QueryRecord[],
  events: [] as string[],
  lockedGym: {} as Record<string, unknown>,
  members: [] as Record<string, unknown>[],
  roles: [] as Record<string, unknown>[],
  boardBeforeLock: [] as Record<string, unknown>[],
  boardAfterLock: [] as Record<string, unknown>[],
  qualifyingBoards: [] as Record<string, unknown>[],
  boardLockFailure: undefined as unknown,
}));
vi.mock('../../../db/client', () => ({ db: { select: (...arguments_: unknown[]) => state.select(...arguments_) } }));
vi.mock('../../../graphql/resolvers/social/gyms', async (importOriginal) => {
  const shared = await importOriginal<typeof import('../../../graphql/resolvers/social/gyms')>();
  state.sharedEdit = shared.userCanEditGym;
  return {
    ...shared,
    resolveCanonicalGymByUuid: state.resolveGym,
    viewerCanSeeGym: state.canSeeGym,
    userCanEditGym: state.requireGymEdit,
    enrichGym: vi.fn(),
  };
});
vi.mock('../../../services/privacy', () => ({ canAccessResource: state.canReadBoard }));
vi.mock('../../../graphql/mask-error', () => ({ isDatabaseLeakError: () => false }));

import { assertBoardInGym, authorizeGymBoardRemoval, resolveGymForTool } from '../domain';

const GYM_UUID = '00000000-0000-4000-8000-000000000001';
const BOARD_UUID = '00000000-0000-4000-8000-000000000002';
const ACTOR = 'gym-actor';

interface QueryDouble {
  from(table: Table): QueryDouble;
  where(predicate: SQL): QueryDouble;
  orderBy(...columns: unknown[]): QueryDouble;
  limit(limit: number): QueryDouble;
  for(mode: string, options?: { noWait?: boolean }): Promise<unknown[]>;
  then(resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown): Promise<unknown>;
}

function rowsFor(query: QueryRecord): unknown[] {
  if (query.table === 'gyms') return [state.lockedGym];
  if (query.table === 'gym_members') return state.members;
  if (query.table === 'community_roles') return state.roles;
  if (query.table === 'user_boards') {
    if (query.lock && state.boardLockFailure) throw state.boardLockFailure;
    return query.lock === 'update'
      ? state.boardAfterLock
      : query.lock === 'share'
        ? state.qualifyingBoards
        : state.boardBeforeLock;
  }
  throw new Error(`Unexpected table ${query.table}`);
}

function selectDouble(): QueryDouble {
  const query: QueryRecord = {};
  state.records.push(query);
  const builder: QueryDouble = {
    from(table) {
      query.table = getTableName(table);
      return builder;
    },
    where(predicate) {
      query.predicate = predicate;
      return builder;
    },
    orderBy(...columns) {
      query.order = columns;
      return builder;
    },
    limit(limit) {
      query.limit = limit;
      return builder;
    },
    async for(mode, options) {
      query.lock = mode;
      query.lockOptions = options;
      state.events.push(`${query.table}:${mode}`);
      return rowsFor(query);
    },
    // oxlint-disable-next-line unicorn/no-thenable -- The double must model Drizzle's awaitable query, including unlocked reads.
    async then(resolve, reject) {
      try {
        return resolve(rowsFor(query));
      } catch (error) {
        if (reject) return reject(error);
        throw error;
      }
    },
  };
  return builder;
}

describe('gym MCP authorization row locks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.records.length = 0;
    state.events.length = 0;
    state.lockedGym = { id: 11, uuid: GYM_UUID, ownerId: ACTOR, isPublic: true };
    state.members = [];
    state.roles = [];
    state.qualifyingBoards = [];
    state.boardBeforeLock = [{ ownerId: ACTOR, gymId: 11 }];
    state.boardAfterLock = [{ ownerId: ACTOR, gymId: 11 }];
    state.boardLockFailure = undefined;
    state.select.mockImplementation(selectDouble);
    state.resolveGym.mockResolvedValue({ ...state.lockedGym });
    state.canSeeGym.mockResolvedValue(true);
    state.canReadBoard.mockResolvedValue(true);
    state.requireGymEdit.mockImplementation(async (...arguments_: Parameters<NonNullable<typeof state.sharedEdit>>) => {
      const allowed = await state.sharedEdit!(...arguments_);
      if (allowed) state.events.push('authorize');
      return allowed;
    });
  });

  it('checks the selected gym against the board version obtained under its exclusive lock', async () => {
    // A first-party move committed between the old unlocked read and this lock.
    state.boardAfterLock = [{ ownerId: ACTOR, gymId: 99 }];
    await expect(authorizeGymBoardRemoval(GYM_UUID, BOARD_UUID, ACTOR, false)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    expect(state.records.find((query) => query.table === 'user_boards')).toMatchObject({
      lock: 'update',
      lockOptions: { noWait: true },
    });
    expect(state.canReadBoard).toHaveBeenCalledOnce();
    const removalPredicate = state.records.find((query) => query.table === 'user_boards')!.predicate!;
    expect(new PgDialect().sqlToQuery(removalPredicate).params).toContain(11);
  });

  it('holds a board lock before allowing an unlink and permits an already-unlinked exact replay', async () => {
    expect(await authorizeGymBoardRemoval(GYM_UUID, BOARD_UUID, ACTOR, false)).toMatchObject({ ownBoard: true });
    expect(state.events).toEqual([
      'gyms:no key update',
      'gym_members:share',
      'community_roles:share',
      'authorize',
      'user_boards:update',
    ]);
    state.boardAfterLock = [{ ownerId: ACTOR, gymId: null }];
    await expect(authorizeGymBoardRemoval(GYM_UUID, BOARD_UUID, ACTOR, true)).resolves.toMatchObject({
      ownBoard: true,
    });
    await expect(authorizeGymBoardRemoval(GYM_UUID, BOARD_UUID, ACTOR, false)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('pins a live matching board before trusting scoped community authority', async () => {
    state.lockedGym.ownerId = 'someone-else';
    state.roles = [
      { role: 'community_leader', boardType: 'kilter' },
      { role: 'tester', boardType: 'tension' },
    ];
    state.qualifyingBoards = [{ id: 20 }];
    await resolveGymForTool(GYM_UUID, ACTOR, true, true);
    expect(state.events).toEqual([
      'gyms:no key update',
      'gym_members:share',
      'community_roles:share',
      'user_boards:share',
      'authorize',
    ]);
    const witnessQuery = state.records.find((query) => query.table === 'user_boards')!;
    expect(witnessQuery).toMatchObject({ limit: 1, lock: 'share', lockOptions: { noWait: true } });
    expect(witnessQuery.order).toHaveLength(1);
    const sql = new PgDialect().sqlToQuery(witnessQuery.predicate!);
    expect(sql.sql).toContain('"deleted_at" is null');
    expect(sql.params).toContain(11);
    expect(sql.params).toContain('kilter');
    expect(sql.params).not.toContain('tension');
  });

  it('refuses scoped authority when the final qualifying board is already gone', async () => {
    state.lockedGym.ownerId = 'someone-else';
    state.roles = [{ role: 'community_leader', boardType: 'kilter' }];
    await expect(resolveGymForTool(GYM_UUID, ACTOR, true, true)).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
    expect(state.requireGymEdit).toHaveBeenCalledOnce();
  });

  it('uses the owner from the locked gym row rather than an earlier ownership snapshot', async () => {
    state.lockedGym.ownerId = 'new-owner';
    state.roles = [{ role: 'community_leader', boardType: 'kilter' }];
    await expect(resolveGymForTool(GYM_UUID, ACTOR, true, true)).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
    expect(state.records.some((query) => query.table === 'user_boards')).toBe(true);
  });

  it('pins grant coverage for a gym editor who also has scoped community leadership', async () => {
    state.lockedGym.ownerId = 'someone-else';
    state.members = [{ role: 'editor' }];
    state.roles = [{ role: 'community_leader', boardType: 'kilter' }];
    await resolveGymForTool(GYM_UUID, ACTOR, true, true);
    expect(state.records.some((query) => query.table === 'user_boards')).toBe(false);
    await expect(resolveGymForTool(GYM_UUID, ACTOR, true, true, 'grant')).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
    expect(state.records.some((query) => query.table === 'user_boards')).toBe(true);
  });

  it('does not lock an unreadable board while checking a removal', async () => {
    state.canReadBoard.mockResolvedValueOnce(false);
    await expect(authorizeGymBoardRemoval(GYM_UUID, BOARD_UUID, ACTOR, false)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    expect(state.records.some((query) => query.table === 'user_boards')).toBe(false);
  });

  it.each(['owner', 'admin', 'editor', 'global-leader', 'public-action'])(
    'does not require a board witness for %s authority',
    async (authority) => {
      state.lockedGym.ownerId = authority === 'owner' ? ACTOR : 'someone-else';
      state.members = authority === 'admin' || authority === 'editor' ? [{ role: authority }] : [];
      state.roles = authority === 'global-leader' ? [{ role: 'community_leader', boardType: null }] : [];
      await resolveGymForTool(GYM_UUID, ACTOR, authority !== 'public-action', true);
      expect(state.records.some((query) => query.table === 'user_boards')).toBe(false);
    },
  );

  it('returns a retryable conflict instead of waiting in the inverse gym/board lock order', async () => {
    state.boardLockFailure = Object.assign(new Error('Row locked'), { cause: { code: '55P03' } });
    await expect(authorizeGymBoardRemoval(GYM_UUID, BOARD_UUID, ACTOR, false)).rejects.toMatchObject({
      extensions: { code: 'CONFLICT' },
    });
    state.lockedGym.ownerId = 'someone-else';
    state.roles = [{ role: 'community_leader', boardType: 'kilter' }];
    await expect(resolveGymForTool(GYM_UUID, ACTOR, true, true)).rejects.toMatchObject({
      extensions: { code: 'CONFLICT' },
    });
    await expect(assertBoardInGym(BOARD_UUID, 11, ACTOR)).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
  });
});
