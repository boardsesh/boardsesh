/**
 * Tests for the updateProfile mutation (issue #3603).
 *
 * Verifies that:
 * - Authentication and input validation are enforced.
 * - The happy path upserts only the fields the caller sent and returns the
 *   merged profile (displayName / avatarUrl / favoriteCount).
 * - Empty input takes the no-write path (an empty `set` would be invalid SQL).
 * - A transient DB failure is caught: the client gets a generic
 *   PROFILE_UPDATE_FAILED GraphQLError with NO raw SQL, while the real
 *   PostgresError cause (with its pg code) is captured to Sentry and the error
 *   is marked reported so the generic Yoga handler doesn't double-report it.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { wasErrorReported } from '../utils/sentry-dedupe';

const { mockDb, sentryCaptureMock, txState } = vi.hoisted(() => {
  const txState = {
    insertCalled: false,
    insertValues: undefined as Record<string, unknown> | undefined,
    upsertSet: undefined as Record<string, unknown> | undefined,
    selectRow: undefined as Record<string, unknown> | undefined,
    failWith: undefined as Error | undefined,
  };

  const makeTx = () => ({
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        txState.insertCalled = true;
        txState.insertValues = values;
        return {
          onConflictDoUpdate: vi.fn((config: { set: Record<string, unknown> }) => {
            txState.upsertSet = config.set;
            return Promise.resolve(undefined);
          }),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(txState.selectRow ? [txState.selectRow] : [])),
          })),
        })),
      })),
    })),
  });

  const mockDb = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      if (txState.failWith) throw txState.failWith;
      return callback(makeTx());
    }),
  };

  return { mockDb, sentryCaptureMock: vi.fn(), txState };
});

vi.mock('../db/client', () => ({ db: mockDb }));
vi.mock('@sentry/node', () => ({ captureException: sentryCaptureMock }));
vi.mock('../graphql/resolvers/users/role-flags', () => ({
  loadProfileRoleFlags: vi.fn().mockResolvedValue({ isTester: false, isAdmin: false }),
}));

function makeAuthCtx(userId = 'user-1'): ConnectionContext {
  return {
    connectionId: `http-${userId}`,
    transport: 'http',
    sessionId: undefined,
    userId,
    isAuthenticated: true,
  };
}

function makeAnonCtx(): ConnectionContext {
  return {
    connectionId: 'http-anon',
    transport: 'http',
    sessionId: undefined,
    userId: undefined,
    isAuthenticated: false,
  };
}

// DrizzleQueryError shape (drizzle-orm >= 0.44): the "Failed query: ..." wrapper
// with the real PostgresError on `.cause`. 57014 = statement_timeout.
function wrapLikeDrizzle(driverError: Error): Error {
  return Object.assign(
    new Error('Failed query: select "id", "email", "name" from "users" where "users"."id" = $1 limit $2'),
    { cause: driverError },
  );
}

const SUCCESS_ROW = {
  id: 'user-1',
  email: 'user1@example.com',
  name: 'Legacy Name',
  image: 'https://img/legacy.png',
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  displayName: 'New Name',
  avatarUrl: 'https://cdn/new.png',
  favoriteCount: 7,
};

describe('updateProfile mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txState.insertCalled = false;
    txState.insertValues = undefined;
    txState.upsertSet = undefined;
    txState.selectRow = { ...SUCCESS_ROW };
    txState.failWith = undefined;
  });

  it('rejects unauthenticated requests', async () => {
    await expect(userMutations.updateProfile({}, { input: { displayName: 'Nope' } }, makeAnonCtx())).rejects.toThrow();
  });

  it('rejects an invalid avatarUrl', async () => {
    await expect(
      userMutations.updateProfile({}, { input: { avatarUrl: 'not-a-url' } }, makeAuthCtx()),
    ).rejects.toThrow();
  });

  it('rejects an over-long displayName', async () => {
    await expect(
      userMutations.updateProfile({}, { input: { displayName: 'a'.repeat(101) } }, makeAuthCtx()),
    ).rejects.toThrow();
  });

  it('returns the merged profile on success', async () => {
    const result = await userMutations.updateProfile(
      {},
      { input: { displayName: 'New Name', avatarUrl: 'https://cdn/new.png' } },
      makeAuthCtx(),
    );

    expect(result).toMatchObject({
      id: 'user-1',
      email: 'user1@example.com',
      displayName: 'New Name',
      avatarUrl: 'https://cdn/new.png',
      favoriteCount: 7,
    });
  });

  it('upserts only the fields present in the input', async () => {
    await userMutations.updateProfile({}, { input: { displayName: 'Only Name' } }, makeAuthCtx());

    expect(txState.insertCalled).toBe(true);
    // `toEqual` with an explicit `updatedAt`, not `toMatchObject`: the point of
    // this test is that a key is ABSENT, and `toMatchObject` tolerates extra
    // keys — it would let a regression re-add `avatarUrl` without failing.
    expect(txState.insertValues).toEqual({
      userId: 'user-1',
      displayName: 'Only Name',
      updatedAt: expect.any(Date),
    });
    // avatarUrl was omitted, so it must NOT appear in the conflict `set` —
    // that preserves the existing avatar instead of nulling it.
    expect(txState.upsertSet).toEqual({ displayName: 'Only Name', updatedAt: expect.any(Date) });
    expect(txState.upsertSet).not.toHaveProperty('avatarUrl');
  });

  it('takes the no-write path when the input is empty', async () => {
    const result = await userMutations.updateProfile({}, { input: {} }, makeAuthCtx());

    expect(txState.insertCalled).toBe(false);
    expect(result.id).toBe('user-1');
  });

  it('returns USER_NOT_FOUND (no SQL, no Sentry) when the user row is gone', async () => {
    txState.selectRow = undefined; // authenticated user vanished mid-request

    let thrown: unknown;
    try {
      await userMutations.updateProfile({}, { input: { displayName: 'Ghost' } }, makeAuthCtx());
      throw new Error('expected updateProfile to reject');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GraphQLError);
    expect((thrown as GraphQLError).extensions?.code).toBe('USER_NOT_FOUND');
    expect((thrown as GraphQLError).message).not.toMatch(/select|Failed query/i);
    // An intentional client-safe error, not a DB failure — nothing to capture.
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });

  it('masks a transient DB failure and captures the real pg cause', async () => {
    const pgError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    txState.failWith = wrapLikeDrizzle(pgError);

    let thrown: unknown;
    try {
      await userMutations.updateProfile({}, { input: { displayName: 'Boom' } }, makeAuthCtx('user-42'));
      throw new Error('expected updateProfile to reject');
    } catch (error) {
      thrown = error;
    }

    // Client sees a generic, SQL-free GraphQLError.
    expect(thrown).toBeInstanceOf(GraphQLError);
    const graphqlError = thrown as GraphQLError;
    expect(graphqlError.extensions?.code).toBe('PROFILE_UPDATE_FAILED');
    expect(graphqlError.message).not.toMatch(/select|Failed query|user_favorites/i);

    // The real PostgresError cause is captured to Sentry with the pg code.
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    expect(sentryCaptureMock).toHaveBeenCalledWith(
      pgError,
      expect.objectContaining({
        tags: expect.objectContaining({ source: 'updateProfile', pgCode: '57014' }),
        extra: expect.objectContaining({ userId: 'user-42', hasDisplayName: true, hasAvatarUrl: false }),
      }),
    );

    // Marked reported so the generic graphql-yoga handler won't double-report.
    expect(wasErrorReported(thrown)).toBe(true);
  });
});
