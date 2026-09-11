// The rules that bound the pin set. `connection-pin.ts` imports expo-sqlite for
// TYPES only, so this suite needs no mocking and runs in the node environment.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn() }));

import { pinDatabase, isDatabasePinned, pinnedDatabaseCount, resetDatabasePinsForTests } from '../connection-pin';

/** The shape `pinDatabase` reads: path, options, and the native object it also pins. */
function connection(overrides: Record<string, unknown> = {}): never {
  return {
    databasePath: '/data/user/0/com.boardsesh.app/databases/boardsesh.db',
    options: {},
    nativeDatabase: {},
    ...overrides,
  } as never;
}

beforeEach(() => {
  resetDatabasePinsForTests();
});

describe('pinDatabase', () => {
  it('pins a connection to the app database', () => {
    const db = connection();
    pinDatabase(db);
    expect(isDatabasePinned(db)).toBe(true);
    expect(pinnedDatabaseCount()).toBe(1);
  });

  it('is idempotent, because onInit, the effect and the init chain all see the same connection', () => {
    const db = connection();
    pinDatabase(db);
    pinDatabase(db);
    pinDatabase(db);
    expect(pinnedDatabaseCount()).toBe(1);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('tolerates %s', (_label, value) => {
    expect(() => {
      pinDatabase(value);
    }).not.toThrow();
    expect(pinnedDatabaseCount()).toBe(0);
  });

  it('refuses a transaction connection', () => {
    // `withExclusiveTransactionAsync` opens with this flag, so it gets a genuinely
    // separate native object whose release is correct. Pinning them would leak one
    // connection object per offline write.
    const txn = connection({ options: { useNewConnection: true } });
    pinDatabase(txn);
    expect(isDatabasePinned(txn)).toBe(false);
    expect(pinnedDatabaseCount()).toBe(0);
  });

  it('refuses a connection to some other database file', () => {
    const other = connection({ databasePath: '/data/user/0/com.boardsesh.app/databases/other.db' });
    pinDatabase(other);
    expect(isDatabasePinned(other)).toBe(false);
  });

  it('pins the native object as well as the wrapper', () => {
    // The NativeState lives on the native object, so pinning it directly means an
    // upstream refactor of the wrapper cannot silently un-pin us.
    const native = {};
    const db = connection({ nativeDatabase: native });
    pinDatabase(db);
    expect(isDatabasePinned(native as never)).toBe(true);
  });

  it('counts mounts rather than set entries', () => {
    pinDatabase(connection());
    pinDatabase(connection());
    expect(pinnedDatabaseCount()).toBe(2);
  });

  it('pins a connection that reports no path, rather than guessing', () => {
    const db = connection({ databasePath: undefined });
    pinDatabase(db);
    expect(isDatabasePinned(db)).toBe(true);
  });
});

describe('isDatabasePinned', () => {
  it('is false for an unpinned connection and for nothing at all', () => {
    expect(isDatabasePinned(connection())).toBe(false);
    expect(isDatabasePinned(null)).toBe(false);
    expect(isDatabasePinned(undefined)).toBe(false);
  });
});
