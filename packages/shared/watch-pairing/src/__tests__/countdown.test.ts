import { describe, expect, it } from 'vitest';
import { remainingSeconds } from '../countdown';
import { isWatchPairingCode } from '../types';

describe('remainingSeconds', () => {
  const now = Date.parse('2026-07-05T12:00:00.000Z');

  it('rounds up partial seconds so a just-issued code shows its full life', () => {
    // 59.5s out reads as 60, not 59 — the user sees the whole window.
    expect(remainingSeconds('2026-07-05T12:00:59.500Z', now)).toBe(60);
  });

  it('counts down whole seconds toward expiry', () => {
    expect(remainingSeconds('2026-07-05T12:00:10.000Z', now)).toBe(10);
    expect(remainingSeconds('2026-07-05T12:00:01.000Z', now)).toBe(1);
  });

  it('clamps to 0 at and past the expiry instant', () => {
    expect(remainingSeconds('2026-07-05T12:00:00.000Z', now)).toBe(0);
    expect(remainingSeconds('2026-07-05T11:59:30.000Z', now)).toBe(0);
  });

  it('fails safe to 0 for an unparseable timestamp', () => {
    expect(remainingSeconds('not-a-date', now)).toBe(0);
  });
});

describe('isWatchPairingCode', () => {
  it('accepts a well-formed pair-code payload', () => {
    expect(isWatchPairingCode({ code: '482913', expiresAt: '2026-07-05T12:00:00.000Z' })).toBe(true);
  });

  it('rejects an object with missing or wrong-typed fields', () => {
    expect(isWatchPairingCode({ code: '482913' })).toBe(false);
    expect(isWatchPairingCode({ expiresAt: '2026-07-05T12:00:00.000Z' })).toBe(false);
    expect(isWatchPairingCode({ code: 482913, expiresAt: '2026-07-05T12:00:00.000Z' })).toBe(false);
    expect(isWatchPairingCode({ code: '482913', expiresAt: 123 })).toBe(false);
  });

  it('rejects null and non-object values', () => {
    expect(isWatchPairingCode(null)).toBe(false);
    expect(isWatchPairingCode(undefined)).toBe(false);
    expect(isWatchPairingCode('482913')).toBe(false);
  });
});
