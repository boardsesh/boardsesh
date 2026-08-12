import { describe, it, expect } from 'vitest';
import { isDatabaseLockedError } from '../lock-errors';

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
