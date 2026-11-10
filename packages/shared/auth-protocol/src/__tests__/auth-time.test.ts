import { describe, expect, it } from 'vitest';
import {
  AUTH_TIME_CLOCK_SKEW_SECONDS,
  isRecentSignIn,
  PASSWORD_CHANGE_CLOCK_TOLERANCE_MS,
  readAuthTimeClaim,
  RECENT_SIGN_IN_MAX_AGE_SECONDS,
  signedInAfterPasswordChange,
} from '../auth-time';

const NOW_MS = Date.UTC(2026, 10, 10, 12, 0, 0, 500);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

describe('readAuthTimeClaim', () => {
  it('takes a whole number of seconds at or before now', () => {
    expect(readAuthTimeClaim(NOW_SECONDS, NOW_MS)).toBe(NOW_SECONDS);
    expect(readAuthTimeClaim(NOW_SECONDS - 86_400, NOW_MS)).toBe(NOW_SECONDS - 86_400);
  });

  it('allows a sign-in up to the clock skew ahead of this clock', () => {
    const ahead = Math.floor(NOW_MS / 1000 + AUTH_TIME_CLOCK_SKEW_SECONDS);
    expect(readAuthTimeClaim(ahead, NOW_MS)).toBe(ahead);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a string', String(NOW_SECONDS)],
    ['a fraction', NOW_SECONDS - 0.5],
    ['milliseconds', NOW_MS],
    ['zero', 0],
    ['negative', -1],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['beyond the clock skew', NOW_SECONDS + AUTH_TIME_CLOCK_SKEW_SECONDS + 1],
    ['too large to be exact', Number.MAX_SAFE_INTEGER + 1],
  ])('treats %s as unknown', (_label, claim) => {
    expect(readAuthTimeClaim(claim, NOW_MS)).toBeNull();
  });

  it('treats any claim as unknown on a broken clock', () => {
    expect(readAuthTimeClaim(NOW_SECONDS, Number.NaN)).toBeNull();
  });
});

describe('isRecentSignIn', () => {
  it('accepts a sign-in a second short of 30 days', () => {
    expect(isRecentSignIn(NOW_SECONDS - RECENT_SIGN_IN_MAX_AGE_SECONDS + 1, NOW_MS)).toBe(true);
  });

  it('refuses a sign-in 30 days old or more', () => {
    expect(isRecentSignIn(Math.floor(NOW_MS / 1000) - RECENT_SIGN_IN_MAX_AGE_SECONDS, NOW_MS)).toBe(false);
    expect(isRecentSignIn(NOW_SECONDS - 40 * 86_400, NOW_MS)).toBe(false);
  });

  it('refuses an unknown sign-in time', () => {
    expect(isRecentSignIn(null, NOW_MS)).toBe(false);
  });
});

describe('signedInAfterPasswordChange', () => {
  const changedAt = new Date(NOW_MS - 3600_000);
  const changedAtSeconds = Math.floor(changedAt.getTime() / 1000);

  it('accepts any sign-in when there is no password', () => {
    expect(signedInAfterPasswordChange(1, null)).toBe(true);
  });

  it('refuses a sign-in from before the change', () => {
    expect(signedInAfterPasswordChange(changedAtSeconds - 86_400, changedAt)).toBe(false);
  });

  it('refuses a sign-in inside the clock tolerance after the change', () => {
    expect(signedInAfterPasswordChange(changedAtSeconds + 59, changedAt)).toBe(false);
    expect(signedInAfterPasswordChange(changedAtSeconds + PASSWORD_CHANGE_CLOCK_TOLERANCE_MS / 1000, changedAt)).toBe(
      false,
    );
  });

  it('accepts a sign-in more than the tolerance after the change', () => {
    expect(signedInAfterPasswordChange(changedAtSeconds + 61, changedAt)).toBe(true);
  });
});
