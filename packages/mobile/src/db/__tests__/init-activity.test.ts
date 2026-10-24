import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginDatabaseInitAttempt,
  isDatabaseInitAttemptRunning,
  resetDatabaseInitActivityForTests,
  subscribeDatabaseInitAttempt,
} from '../init-activity';

afterEach(() => {
  resetDatabaseInitActivityForTests();
});

// #6689. The launch update gate holds its reload while any setup attempt runs.
// A dead-handle recovery (#5410) starts a second init chain while the old one
// may still be mid-attempt, so the old chain finishing must not report idle.
describe('database init activity', () => {
  it('stays running until every overlapping attempt has ended, and notifies only on the edges', () => {
    const listener = vi.fn(() => isDatabaseInitAttemptRunning());
    subscribeDatabaseInitAttempt(listener);

    const endFirst = beginDatabaseInitAttempt();
    const endSecond = beginDatabaseInitAttempt();
    expect(isDatabaseInitAttemptRunning()).toBe(true);

    endFirst();
    expect(isDatabaseInitAttemptRunning()).toBe(true);

    endSecond();
    expect(isDatabaseInitAttemptRunning()).toBe(false);
    expect(listener.mock.results.map((result) => result.value)).toEqual([true, false]);

    // Ending an attempt twice is a no-op: it must not drive the count below zero
    // and hide the next attempt.
    endFirst();
    const endThird = beginDatabaseInitAttempt();
    expect(isDatabaseInitAttemptRunning()).toBe(true);
    endThird();
    expect(isDatabaseInitAttemptRunning()).toBe(false);
  });

  it('keeps notifying the other listeners when one throws', () => {
    const second = vi.fn();
    subscribeDatabaseInitAttempt(() => {
      throw new Error('listener failed');
    });
    subscribeDatabaseInitAttempt(second);

    expect(() => beginDatabaseInitAttempt()).not.toThrow();
    expect(second).toHaveBeenCalledOnce();
  });
});
