// Pins both entry points against the LITERAL strings Sentry carries for
// `source:offline-sync kind:sqlite-init` / `kind:tick-local-write`. Every case
// here was copied from a real event, because the whole point of the module is
// that these shapes differ per platform and cannot be guessed from the
// expo-sqlite type definitions.

import { describe, it, expect } from 'vitest';
import { classifySqliteLockError, isDatabaseLockedError } from '../lock-errors';

// The Android driver emits a raw U+0005 where the result-code digit belongs
// (BOARDSESH-6V, all 18 events). Built here rather than pasted so no editor,
// formatter, or copy/paste can quietly drop the byte and turn this test green
// against the wrong string.
const ANDROID_CODE_BYTE = String.fromCharCode(5);

describe('isDatabaseLockedError', () => {
  it.each([
    ["Calling the 'execAsync' function has failed", 'database is locked'],
    ["Calling the 'finalizeAsync' function has failed", 'Error code 5: database is locked'],
    ["Calling the 'prepareAsync' function has failed", `Error code ${ANDROID_CODE_BYTE}: database is locked`],
  ])('matches the real Sentry shape %s', (message, causeMessage) => {
    expect(isDatabaseLockedError(new Error(message, { cause: new Error(causeMessage) }))).toBe(true);
  });

  it('matches the iOS 2.3.1 exception shape', () => {
    expect(isDatabaseLockedError(new Error('SQLiteErrorException: Error code 5: database is locked'))).toBe(true);
  });

  it('matches a bare SQLITE_BUSY code', () => {
    expect(isDatabaseLockedError(Object.assign(new Error('write failed'), { code: 'SQLITE_BUSY' }))).toBe(true);
  });

  it('matches through a nested cause chain', () => {
    const nested = new Error('outer', { cause: new Error('middle', { cause: new Error('database is locked') }) });
    expect(isDatabaseLockedError(nested)).toBe(true);
  });

  it('stops at the cause depth limit instead of walking forever', () => {
    const tooDeep = new Error('1', {
      cause: new Error('2', { cause: new Error('3', { cause: new Error('4', { cause: 'database is locked' }) }) }),
    });
    expect(isDatabaseLockedError(tooDeep)).toBe(false);
  });

  it('survives a self-referential cause', () => {
    const looping: { message: string; cause?: unknown } = { message: 'boom' };
    looping.cause = looping;
    expect(isDatabaseLockedError(looping)).toBe(false);
  });

  it.each([
    new TypeError("Cannot read property 'foo' of undefined"),
    new Error('database disk image is malformed'),
    new Error('Error code 13: database or disk is full'),
    null,
    undefined,
    'some string',
  ])('does not match %p', (value) => {
    expect(isDatabaseLockedError(value)).toBe(false);
  });
});

describe('classifySqliteLockError', () => {
  it('reads the iOS 2.2.2 single-line cause chain as retryable contention', () => {
    const result = classifySqliteLockError(
      new Error("Calling the 'prepareAsync' function has failed → Caused by: Error code 5: database is locked"),
    );

    expect(result).toEqual({ locked: true, code: 5 });
  });

  it('reads the iOS 2.3.x multi-line SQLiteErrorException chain as retryable contention', () => {
    const result = classifySqliteLockError(
      new Error(
        "FunctionCallException: Calling the 'prepareAsync' function has failed (at ExpoModulesCore/AsyncFunctionDefinition.swift:123)\n" +
          '→ Caused by: SQLiteErrorException: Error code 5: database is locked (at ExpoSQLite/SQLiteModule.swift:382)',
      ),
    );

    expect(result).toEqual({ locked: true, code: 5 });
  });

  it('reads the Android shape, where the numeric code is omitted entirely', () => {
    // This is the case a code-only classifier would silently stop retrying: Android
    // prints "Error code : database is locked" with nothing between the words.
    const result = classifySqliteLockError(
      new Error(
        "Call to function 'NativeDatabase.prepareAsync' has been rejected.\n→ Caused by: Error code : database is locked",
      ),
    );

    expect(result).toEqual({ locked: true, code: null });
  });

  it('reads the Android shape that prints the digit as a raw control byte', () => {
    const result = classifySqliteLockError(
      new Error(
        `Calling the 'prepareAsync' function has failed → Caused by: Error code ${ANDROID_CODE_BYTE}: database is locked`,
      ),
    );

    expect(result).toEqual({ locked: true, code: null });
  });

  it('agrees with isDatabaseLockedError on a wrapped cause chain', () => {
    // No code in the outer message, so the verdict comes from the shared
    // predicate, which walks the cause chain the reporting side already trusts.
    const wrapped = new Error("Calling the 'execAsync' function has failed", {
      cause: new Error('database is locked'),
    });

    expect(classifySqliteLockError(wrapped)).toEqual({ locked: true, code: null });
    expect(isDatabaseLockedError(wrapped)).toBe(true);
  });

  it('treats "database table is locked" (SQLITE_LOCKED) as retryable', () => {
    const result = classifySqliteLockError(new Error('Error code 6: database table is locked'));

    expect(result).toEqual({ locked: true, code: 6 });
  });

  it('unpacks an extended busy code so a recovery-phase collision still retries', () => {
    // 261 = SQLITE_BUSY_RECOVERY (5 | 1<<8). Comparing the raw code against 5 would
    // report a plainly transient failure as permanent.
    const result = classifySqliteLockError(new Error('Error code 261: database is locked'));

    expect(result).toEqual({ locked: true, code: 261 });
  });

  it('does NOT retry a disk-I/O failure (code 10)', () => {
    // BOARDSESH-BN. A full or failing disk fails identically forever — burning the
    // retry window on it only delays the report.
    const result = classifySqliteLockError(new Error('Error code 10: disk I/O error'));

    expect(result).toEqual({ locked: false, code: 10 });
  });

  it('lets a numeric code beat lock-sounding prose', () => {
    const result = classifySqliteLockError(
      new Error('Error code 11: database disk image is malformed while database is locked'),
    );

    expect(result).toEqual({ locked: false, code: 11 });
  });

  it('classifies an ordinary non-SQLite error as not retryable', () => {
    expect(classifySqliteLockError(new Error('Network request failed'))).toEqual({ locked: false, code: null });
  });

  it('handles a thrown non-Error value without throwing', () => {
    expect(classifySqliteLockError('database is locked')).toEqual({ locked: true, code: null });
    expect(classifySqliteLockError(undefined)).toEqual({ locked: false, code: null });
  });
});
