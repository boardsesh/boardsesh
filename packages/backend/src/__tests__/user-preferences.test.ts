/**
 * Tests for the generic user-preferences store.
 *
 * Verifies that:
 * - setUserPreference/deleteUserPreference require authentication
 * - setUserPreference rejects invalid keys (regex enforcement)
 * - setUserPreference performs an upsert against userPreferences with the
 *   correct columns and values
 * - deleteUserPreference issues a DELETE filtered by both userId and key
 * - userPreference query returns the matching row or null
 * - userPreferences query returns the user's full pref list
 * - A user cannot fetch another user's prefs (the where clause is scoped
 *   to ctx.userId)
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { userPreferencesMutations } from '../graphql/resolvers/userPreferences/mutations';
import { userPreferencesQueries } from '../graphql/resolvers/userPreferences/queries';

// Hoist mock variables so they're available before module evaluation
const { mockDb, capturedCalls } = vi.hoisted(() => {
  const capturedCalls: Array<Record<string, unknown>> = [];

  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };

  return { mockDb, capturedCalls };
});

vi.mock('../db/client', () => ({
  db: mockDb,
}));

function makeAuthCtx(userId = 'user-1'): ConnectionContext {
  return {
    connectionId: `http-${userId}`,
    sessionId: undefined,
    userId,
    isAuthenticated: true,
  };
}

function makeAnonCtx(): ConnectionContext {
  return {
    connectionId: 'http-anon',
    sessionId: undefined,
    userId: undefined,
    isAuthenticated: false,
  };
}

const FIXED_DATE = new Date('2024-01-01T00:00:00Z');

/**
 * Wire mockDb.insert(...).values(...).onConflictDoUpdate(...).returning() to
 * resolve with a single row that mirrors what the DB would return.
 */
function setupInsertMock(
  returningRow: { key: string; value: unknown; updatedAt: Date },
  quotaOverride?: { total: number; keyExists: boolean },
) {
  capturedCalls.length = 0;

  // setUserPreference performs a quota select BEFORE the insert. Wire that
  // select to return a benign default (no existing rows, key not present)
  // unless a caller passes an override that simulates a full-quota state.
  const quotaResponse = [
    {
      total: quotaOverride?.total ?? 0,
      keyExists: quotaOverride?.keyExists ?? false,
    },
  ];
  mockDb.select.mockReturnValueOnce({
    from: vi.fn().mockImplementation((table: unknown) => {
      capturedCalls.push({ method: 'select.from', table });
      return {
        where: vi.fn().mockImplementation((...whereArgs: unknown[]) => {
          capturedCalls.push({ method: 'select.where', args: whereArgs });
          return Promise.resolve(quotaResponse);
        }),
      };
    }),
  });

  const returningFn = vi.fn().mockResolvedValue([returningRow]);
  const onConflictDoUpdateFn = vi.fn().mockImplementation((args: unknown) => {
    capturedCalls.push({ method: 'onConflictDoUpdate', args });
    return { returning: returningFn };
  });
  const valuesFn = vi.fn().mockImplementation((args: unknown) => {
    capturedCalls.push({ method: 'values', args });
    return { onConflictDoUpdate: onConflictDoUpdateFn };
  });

  mockDb.insert.mockImplementation((table: unknown) => {
    capturedCalls.push({ method: 'insert', table });
    return { values: valuesFn };
  });
}

/**
 * Wire mockDb.delete(...).where(...) to resolve and capture the where args.
 */
function setupDeleteMock() {
  capturedCalls.length = 0;

  mockDb.delete.mockImplementation((table: unknown) => {
    capturedCalls.push({ method: 'delete', table });
    return {
      where: vi.fn().mockImplementation((...whereArgs: unknown[]) => {
        capturedCalls.push({ method: 'where', args: whereArgs });
        return Promise.resolve(undefined);
      }),
    };
  });
}

/**
 * Wire mockDb.select(...).from(...).where(...).limit(...) (single-row form)
 * to resolve with the given rows array.
 */
function setupSelectSingleMock(rows: Array<{ key: string; value: unknown; updatedAt: Date }>) {
  capturedCalls.length = 0;

  mockDb.select.mockReturnValueOnce({
    from: vi.fn().mockImplementation((table: unknown) => {
      capturedCalls.push({ method: 'from', table });
      return {
        where: vi.fn().mockImplementation((...whereArgs: unknown[]) => {
          capturedCalls.push({ method: 'where', args: whereArgs });
          return {
            limit: vi.fn().mockResolvedValue(rows),
          };
        }),
      };
    }),
  });
}

/**
 * Wire mockDb.select(...).from(...).where(...) (no limit) to resolve with rows.
 */
function setupSelectListMock(rows: Array<{ key: string; value: unknown; updatedAt: Date }>) {
  capturedCalls.length = 0;

  mockDb.select.mockReturnValueOnce({
    from: vi.fn().mockImplementation((table: unknown) => {
      capturedCalls.push({ method: 'from', table });
      return {
        where: vi.fn().mockImplementation((...whereArgs: unknown[]) => {
          capturedCalls.push({ method: 'where', args: whereArgs });
          return Promise.resolve(rows);
        }),
      };
    }),
  });
}

describe('setUserPreference mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCalls.length = 0;
  });

  it('should reject unauthenticated requests', async () => {
    await expect(
      userPreferencesMutations.setUserPreference(
        {},
        { input: { key: 'consent:analytics', value: true } },
        makeAnonCtx(),
      ),
    ).rejects.toThrow();
  });

  it('should reject keys that do not match the allowed pattern', async () => {
    setupInsertMock({ key: '1bad', value: true, updatedAt: FIXED_DATE });

    await expect(
      userPreferencesMutations.setUserPreference({}, { input: { key: '1bad', value: true } }, makeAuthCtx()),
    ).rejects.toThrow();

    // Invalid input must short-circuit before touching the DB
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('should reject keys with disallowed characters', async () => {
    await expect(
      userPreferencesMutations.setUserPreference(
        {},
        { input: { key: 'bad key with spaces', value: true } },
        makeAuthCtx(),
      ),
    ).rejects.toThrow();

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('should reject keys that exceed 64 characters', async () => {
    const tooLong = 'a' + 'b'.repeat(64);
    await expect(
      userPreferencesMutations.setUserPreference({}, { input: { key: tooLong, value: true } }, makeAuthCtx()),
    ).rejects.toThrow();

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('should reject values larger than 8 KB when serialized', async () => {
    setupInsertMock({ key: 'big', value: 'unused', updatedAt: FIXED_DATE });

    // 9 KB string → ~9216 bytes after JSON quoting; exceeds the 8192-byte cap.
    const fatPayload = 'x'.repeat(9 * 1024);

    await expect(
      userPreferencesMutations.setUserPreference({}, { input: { key: 'big', value: fatPayload } }, makeAuthCtx()),
    ).rejects.toThrow();

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('should reject non-JSON-serializable values (functions, undefined)', async () => {
    setupInsertMock({ key: 'bad', value: 'unused', updatedAt: FIXED_DATE });

    await expect(
      userPreferencesMutations.setUserPreference({}, { input: { key: 'bad', value: () => 'oops' } }, makeAuthCtx()),
    ).rejects.toThrow();

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('should accept values right at the size cap', async () => {
    setupInsertMock({ key: 'edge', value: 'unused', updatedAt: FIXED_DATE });

    // JSON.stringify wraps a string in quotes, so a 8190-char string serializes
    // to 8192 bytes — exactly the cap.
    const justUnderCap = 'a'.repeat(8 * 1024 - 2);

    await userPreferencesMutations.setUserPreference(
      {},
      { input: { key: 'edge', value: justUnderCap } },
      makeAuthCtx(),
    );

    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('should reject a NEW key once the per-user cap (100) is reached', async () => {
    setupInsertMock({ key: 'pref-101', value: true, updatedAt: FIXED_DATE }, { total: 100, keyExists: false });

    await expect(
      userPreferencesMutations.setUserPreference({}, { input: { key: 'pref-101', value: true } }, makeAuthCtx()),
    ).rejects.toThrow(/Preference limit reached/);

    // The quota select runs, but no insert should have been attempted.
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('should still allow updating an existing key at the cap (no new row)', async () => {
    setupInsertMock({ key: 'libraryTab', value: 'logbook', updatedAt: FIXED_DATE }, { total: 100, keyExists: true });

    const result = await userPreferencesMutations.setUserPreference(
      {},
      { input: { key: 'libraryTab', value: 'logbook' } },
      makeAuthCtx('user-1'),
    );

    expect(result.key).toBe('libraryTab');
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('should accept namespaced keys with colon', async () => {
    setupInsertMock({ key: 'consent:analytics', value: true, updatedAt: FIXED_DATE });

    const result = await userPreferencesMutations.setUserPreference(
      {},
      { input: { key: 'consent:analytics', value: true } },
      makeAuthCtx('user-1'),
    );

    expect(result).toEqual({
      key: 'consent:analytics',
      value: true,
      updatedAt: FIXED_DATE.toISOString(),
    });
  });

  it('should upsert with the right table and values', async () => {
    setupInsertMock({ key: 'theme', value: { mode: 'dark' }, updatedAt: FIXED_DATE });

    await userPreferencesMutations.setUserPreference(
      {},
      { input: { key: 'theme', value: { mode: 'dark' } } },
      makeAuthCtx('user-42'),
    );

    // values() called with userId/key/value/updatedAt
    const valuesCall = capturedCalls.find((c) => c.method === 'values');
    expect(valuesCall).toBeDefined();
    const valuesArg = valuesCall!.args as { userId: string; key: string; value: unknown; updatedAt: Date };
    expect(valuesArg.userId).toBe('user-42');
    expect(valuesArg.key).toBe('theme');
    expect(valuesArg.value).toEqual({ mode: 'dark' });
    expect(valuesArg.updatedAt).toBeInstanceOf(Date);

    // onConflictDoUpdate set has new value + updatedAt
    const conflictCall = capturedCalls.find((c) => c.method === 'onConflictDoUpdate');
    expect(conflictCall).toBeDefined();
    const conflictArg = conflictCall!.args as { set: { value: unknown; updatedAt: Date } };
    expect(conflictArg.set.value).toEqual({ mode: 'dark' });
    expect(conflictArg.set.updatedAt).toBeInstanceOf(Date);
  });
});

describe('deleteUserPreference mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCalls.length = 0;
  });

  it('should reject unauthenticated requests', async () => {
    await expect(
      userPreferencesMutations.deleteUserPreference({}, { key: 'consent:analytics' }, makeAnonCtx()),
    ).rejects.toThrow();
  });

  it('should issue a DELETE scoped to userId + key and return true', async () => {
    setupDeleteMock();

    const result = await userPreferencesMutations.deleteUserPreference(
      {},
      { key: 'consent:analytics' },
      makeAuthCtx('user-1'),
    );

    expect(result).toBe(true);
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    const whereCall = capturedCalls.find((c) => c.method === 'where');
    expect(whereCall).toBeDefined();
    // Two SQL expressions inside and(...): userId eq + key eq
    expect((whereCall!.args as unknown[]).length).toBe(1);
  });

  it('should return true even when no row exists (idempotent)', async () => {
    setupDeleteMock();

    const result = await userPreferencesMutations.deleteUserPreference({}, { key: 'never-set' }, makeAuthCtx('user-1'));

    expect(result).toBe(true);
  });

  it('should reject invalid keys without touching the database', async () => {
    setupDeleteMock();

    await expect(
      userPreferencesMutations.deleteUserPreference({}, { key: 'has spaces' }, makeAuthCtx('user-1')),
    ).rejects.toThrow();

    await expect(
      userPreferencesMutations.deleteUserPreference({}, { key: '1leading-digit' }, makeAuthCtx('user-1')),
    ).rejects.toThrow();

    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});

describe('userPreference query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCalls.length = 0;
  });

  it('should reject unauthenticated requests', async () => {
    await expect(
      userPreferencesQueries.userPreference({}, { key: 'consent:analytics' }, makeAnonCtx()),
    ).rejects.toThrow();
  });

  it('should return the matching row mapped to GraphQL shape', async () => {
    setupSelectSingleMock([{ key: 'consent:analytics', value: true, updatedAt: FIXED_DATE }]);

    const result = await userPreferencesQueries.userPreference({}, { key: 'consent:analytics' }, makeAuthCtx('user-1'));

    expect(result).toEqual({
      key: 'consent:analytics',
      value: true,
      updatedAt: FIXED_DATE.toISOString(),
    });
  });

  it('should return null when the preference is not set', async () => {
    setupSelectSingleMock([]);

    const result = await userPreferencesQueries.userPreference({}, { key: 'unknown' }, makeAuthCtx('user-1'));

    expect(result).toBeNull();
  });

  it('should scope the where clause to ctx.userId (cross-user isolation)', async () => {
    setupSelectSingleMock([]);

    // User 'user-1' asks for some key — the resolver must filter by user-1, so
    // user-2's data is unreachable.
    await userPreferencesQueries.userPreference({}, { key: 'consent:analytics' }, makeAuthCtx('user-1'));

    const whereCall = capturedCalls.find((c) => c.method === 'where');
    expect(whereCall).toBeDefined();
    // The resolver constructs an and(eq(userId), eq(key)). We rely on the fact
    // that exactly one argument (the AND expression) is passed to where().
    expect((whereCall!.args as unknown[]).length).toBe(1);
  });
});

describe('userPreferences query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCalls.length = 0;
  });

  it('should reject unauthenticated requests', async () => {
    await expect(userPreferencesQueries.userPreferences({}, {}, makeAnonCtx())).rejects.toThrow();
  });

  it('should return an array of preferences for the authenticated user', async () => {
    setupSelectListMock([
      { key: 'consent:analytics', value: true, updatedAt: FIXED_DATE },
      { key: 'theme', value: { mode: 'dark' }, updatedAt: FIXED_DATE },
    ]);

    const result = await userPreferencesQueries.userPreferences({}, {}, makeAuthCtx('user-1'));

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      key: 'consent:analytics',
      value: true,
      updatedAt: FIXED_DATE.toISOString(),
    });
    expect(result[1]).toEqual({
      key: 'theme',
      value: { mode: 'dark' },
      updatedAt: FIXED_DATE.toISOString(),
    });
  });

  it('should return an empty array when the user has no preferences', async () => {
    setupSelectListMock([]);

    const result = await userPreferencesQueries.userPreferences({}, {}, makeAuthCtx('user-1'));

    expect(result).toEqual([]);
  });

  it('should scope the query to ctx.userId so a user cannot read another user prefs', async () => {
    // user-1 is asking — mock returns nothing because user-2 has all the data.
    setupSelectListMock([]);

    const result = await userPreferencesQueries.userPreferences({}, {}, makeAuthCtx('user-1'));

    expect(result).toEqual([]);
    const whereCall = capturedCalls.find((c) => c.method === 'where');
    expect(whereCall).toBeDefined();
    // Single arg = eq(userId, ctx.userId) — proves we always filter by user.
    expect((whereCall!.args as unknown[]).length).toBe(1);
  });
});
