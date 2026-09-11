// Pins the dead-handle classifier against the LITERAL strings Sentry carries
// for BOARDSESH-G1 / BOARDSESH-CF, and — just as importantly — against the lock
// shapes it must NEVER claim. The whole value of the module is that these two
// families look similar and need opposite handling: a lock is retried on the
// same connection, a dead handle can only be recovered by re-opening.
//
// The Android shape is reconstructed the way `CodedException.kt` builds it:
//   "Call to function '<class>.<method>' has been rejected."
//   + lineSeparator + "→ Caused by: " + (cause.localizedMessage ?: cause)
// and `toString()` on a message-less NullPointerException is the bare class
// name, which is why there is nothing after the final colon to key on.

import { describe, it, expect } from 'vitest';
import { classifySqliteHandleError, isDeadDatabaseHandleError } from '../handle-errors';
import { classifySqliteLockError, isDatabaseLockedError } from '../lock-errors';

const ANDROID_CODE_BYTE = String.fromCharCode(5);

/** Exactly what BOARDSESH-G1 carries, as one flat message. */
function androidDeadHandle(method = 'prepareAsync', klass = 'NativeDatabase'): string {
  return `Call to function '${klass}.${method}' has been rejected.\n→ Caused by: java.lang.NullPointerException: java.lang.NullPointerException`;
}

/** The shapes that must be recovered by re-opening. */
const DEAD_HANDLE_SHAPES: [label: string, error: unknown][] = [
  ['android NPE, flat message', new Error(androidDeadHandle())],
  ['android NPE, execAsync', new Error(androidDeadHandle('execAsync'))],
  ['android NPE, NativeStatement.runAsync', new Error(androidDeadHandle('runAsync', 'NativeStatement'))],
  ['android NPE, NativeSession.createAsync', new Error(androidDeadHandle('createAsync', 'NativeSession'))],
  [
    'android NPE split across a cause',
    new Error("Call to function 'NativeDatabase.prepareAsync' has been rejected.", {
      cause: new Error('java.lang.NullPointerException'),
    }),
  ],
  ['bare access-to-closed', new Error('Access to closed resource')],
  [
    'android-decorated access-to-closed',
    new Error(
      "Call to function 'NativeDatabase.prepareAsync' has been rejected.\n→ Caused by: Access to closed resource",
    ),
  ],
  [
    'iOS access-to-closed',
    new Error("Calling the 'prepareAsync' function has failed", { cause: new Error('Access to closed resource') }),
  ],
];

/** Every lock shape from the sibling suite. None of these is a handle failure. */
const LOCK_SHAPES: [label: string, error: unknown][] = [
  [
    'iOS execAsync lock',
    new Error("Calling the 'execAsync' function has failed", { cause: new Error('database is locked') }),
  ],
  [
    'iOS prepareAsync lock with code',
    new Error("Calling the 'prepareAsync' function has failed", {
      cause: new Error('Error code 5: database is locked'),
    }),
  ],
  [
    'android lock with the raw control byte',
    new Error("Call to function 'NativeDatabase.prepareAsync' has been rejected.", {
      cause: new Error(`Error code ${ANDROID_CODE_BYTE}: database is locked`),
    }),
  ],
  ['iOS 2.3.1 exception', new Error('SQLiteErrorException: Error code 5: database is locked')],
  ['bare SQLITE_BUSY code', Object.assign(new Error('write failed'), { code: 'SQLITE_BUSY' })],
];

describe('classifySqliteHandleError', () => {
  it.each(DEAD_HANDLE_SHAPES)('recognises %s', (_label, error) => {
    expect(isDeadDatabaseHandleError(error)).toBe(true);
  });

  it('tells the freed binding apart from an honest close', () => {
    expect(classifySqliteHandleError(new Error(androidDeadHandle()))).toBe('dead-native-handle');
    expect(classifySqliteHandleError(new Error('Access to closed resource'))).toBe('closed');
  });

  it('needs the expo-sqlite frame as well as the NullPointerException', () => {
    // A bare NPE is the most common native error there is. Matching it alone
    // would make every unrelated Android module failure re-open SQLite.
    expect(isDeadDatabaseHandleError(new Error('java.lang.NullPointerException'))).toBe(false);
    expect(
      isDeadDatabaseHandleError(
        new Error(
          "Call to function 'ExpoUpdates.fetchUpdateAsync' has been rejected.\n→ Caused by: java.lang.NullPointerException",
        ),
      ),
    ).toBe(false);
  });

  it('needs the NullPointerException as well as the frame', () => {
    expect(
      isDeadDatabaseHandleError(new Error("Call to function 'NativeDatabase.prepareAsync' has been rejected.")),
    ).toBe(false);
  });

  it.each([
    ['an ordinary type error', new TypeError("Cannot read property 'x' of undefined")],
    [
      'a full disk',
      new Error("Calling the 'execAsync' function has failed", { cause: new Error('database or disk is full') }),
    ],
    ['nothing at all', null],
    ['undefined', undefined],
    ['an empty object', {}],
  ])('ignores %s', (_label, error) => {
    expect(classifySqliteHandleError(error)).toBeNull();
  });

  it('stops at the cause depth limit instead of walking forever', () => {
    const tooDeep = new Error("Call to function 'NativeDatabase.prepareAsync' has been rejected.", {
      cause: new Error('2', {
        cause: new Error('3', { cause: new Error('4', { cause: 'java.lang.NullPointerException' }) }),
      }),
    });
    expect(isDeadDatabaseHandleError(tooDeep)).toBe(false);
  });

  it('survives a self-referential cause', () => {
    const looped: Error & { cause?: unknown } = new Error(androidDeadHandle());
    looped.cause = looped;
    expect(isDeadDatabaseHandleError(looped)).toBe(true);
  });

  it('reads a plain string', () => {
    expect(classifySqliteHandleError(androidDeadHandle())).toBe('dead-native-handle');
  });
});

// The two classifiers must partition the error space. If they ever start
// agreeing, a dead handle would be retried on the same dead connection until
// the write budget runs out, or a lock would trigger a pointless re-open.
describe('mutual exclusivity with the lock classifier', () => {
  it.each(DEAD_HANDLE_SHAPES)('%s is not read as a lock', (_label, error) => {
    expect(isDatabaseLockedError(error)).toBe(false);
    expect(classifySqliteLockError(error).locked).toBe(false);
  });

  it.each(LOCK_SHAPES)('%s is not read as a handle failure', (_label, error) => {
    expect(classifySqliteHandleError(error)).toBeNull();
  });
});
