import { describe, expect, it } from 'vitest';
import { RETRY_AFTER_PARSE_CEILING_MS, parseRetryAfterMs } from './retry-after';
import { isSyncDaemonDisabled } from './daemon-switch';

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');

  it('reads delta-seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('120', now)).toBe(120_000);
    expect(parseRetryAfterMs(' 0 ', now)).toBe(0);
    expect(parseRetryAfterMs('Sun, 27 Sep 2026 12:01:30 GMT', now)).toBe(90_000);
  });

  it('never goes negative and ignores what it cannot read', () => {
    expect(parseRetryAfterMs('Sun, 27 Sep 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
    expect(parseRetryAfterMs('', now)).toBeUndefined();
    expect(parseRetryAfterMs('-5', now)).toBeUndefined();
    expect(parseRetryAfterMs('soon', now)).toBeUndefined();
    expect(parseRetryAfterMs('   ', now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
    expect(parseRetryAfterMs('NaN', now)).toBeUndefined();
    expect(parseRetryAfterMs('1.5', now)).toBeUndefined();
  });

  it('caps a huge delta at a finite ceiling instead of overflowing', () => {
    const twentyNines = parseRetryAfterMs('9'.repeat(20), now);
    expect(twentyNines).toBe(RETRY_AFTER_PARSE_CEILING_MS);
    expect(Number.isFinite(twentyNines)).toBe(true);
    // A string long enough that Number() itself returns Infinity.
    expect(parseRetryAfterMs('9'.repeat(400), now)).toBe(RETRY_AFTER_PARSE_CEILING_MS);
    // One second past the ceiling is clamped; the ceiling itself is not.
    const ceilingSeconds = RETRY_AFTER_PARSE_CEILING_MS / 1000;
    expect(parseRetryAfterMs(String(ceilingSeconds), now)).toBe(RETRY_AFTER_PARSE_CEILING_MS);
    expect(parseRetryAfterMs(String(ceilingSeconds + 1), now)).toBe(RETRY_AFTER_PARSE_CEILING_MS);
  });

  it('treats a date before now as now and caps a far-future date', () => {
    expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs('Fri, 31 Dec 9999 23:59:59 GMT', now)).toBe(RETRY_AFTER_PARSE_CEILING_MS);
  });
});

describe('isSyncDaemonDisabled', () => {
  it('disables only on the literal true', () => {
    expect(isSyncDaemonDisabled({ SYNC_DAEMON_DISABLED: 'true' })).toBe(true);
    expect(isSyncDaemonDisabled({ SYNC_DAEMON_DISABLED: ' true ' })).toBe(true);
    expect(isSyncDaemonDisabled({})).toBe(false);
    expect(isSyncDaemonDisabled({ SYNC_DAEMON_DISABLED: 'false' })).toBe(false);
    expect(isSyncDaemonDisabled({ SYNC_DAEMON_DISABLED: 'TRUE' })).toBe(false);
    expect(isSyncDaemonDisabled({ SYNC_DAEMON_DISABLED: '1' })).toBe(false);
  });
});
