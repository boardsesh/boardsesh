import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs } from './retry-after';
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
