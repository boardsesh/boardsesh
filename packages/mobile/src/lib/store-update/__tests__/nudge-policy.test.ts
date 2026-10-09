import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MobileStoreRelease } from '@boardsesh/shared-schema/mobile-store-release';
import {
  DAY_MS,
  getStoreUpdateStage,
  makeStoreUpdateQaRelease,
  parseStoreUpdateAcknowledgment,
  readStoreUpdateQaStage,
  type StoreUpdateStage,
} from '../nudge-policy';

const NOW = Date.parse('2026-10-06T00:00:00.000Z');
function release(ageMs: number, overrides: Partial<MobileStoreRelease> = {}): MobileStoreRelease {
  return {
    latestVersion: '2.7.0',
    firstNewerMinorAvailableAt: new Date(NOW - ageMs).toISOString(),
    checkedAt: new Date(NOW).toISOString(),
    storeUrl: 'https://apps.apple.com/app/boardsesh/id6761350784',
    ...overrides,
  };
}
function stage(ageMs: number, overrides: Partial<Parameters<typeof getStoreUpdateStage>[0]> = {}) {
  return getStoreUpdateStage({
    release: release(ageMs),
    nativeVersion: '2.6.0',
    acknowledgment: null,
    nowMs: NOW,
    ...overrides,
  });
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('store update reminder policy', () => {
  it.each([
    [14 * DAY_MS - 1, null],
    [14 * DAY_MS, 'weekly'],
    [30 * DAY_MS - 1, 'weekly'],
    [30 * DAY_MS, 'frequent'],
    [60 * DAY_MS - 1, 'frequent'],
    [60 * DAY_MS, 'daily'],
  ])('uses release age %d to choose %s', (ageMs, expected) => {
    expect(stage(ageMs as number)).toBe(expected);
  });

  it.each([
    [14, 7, 'weekly'],
    [30, 3, 'frequent'],
    [60, 1, 'daily'],
  ] as const)('waits %d-day stage cooldown of %d days', (ageDays, cooldownDays, expected) => {
    const acknowledgment = { nativeVersion: '2.6.0', lastAcknowledgedAtMs: NOW - cooldownDays * DAY_MS + 1 };
    expect(stage(ageDays * DAY_MS, { acknowledgment })).toBeNull();
    expect(
      stage(ageDays * DAY_MS, {
        acknowledgment: { ...acknowledgment, lastAcknowledgedAtMs: acknowledgment.lastAcknowledgedAtMs - 1 },
      }),
    ).toBe(expected);
  });

  it.each([
    ['2.6.0', '2.6.1', null],
    ['2.6.0', '2.6.0', null],
    ['2.6.0', '2.5.9', null],
    ['2.9.0', '2.10.0', 'daily'],
    ['2.6.0', '3.0.0', 'daily'],
    ['3.0.0', '2.99.0', null],
    ['unknown', '2.7.0', null],
    ['2.6.0', '2.7.0-beta', null],
  ])('compares native %s and latest %s numerically', (nativeVersion, latestVersion, expected) => {
    expect(stage(60 * DAY_MS, { nativeVersion, release: release(60 * DAY_MS, { latestVersion }) })).toBe(expected);
  });

  it.each([
    { checkedAt: 'invalid' },
    { firstNewerMinorAvailableAt: 'invalid' },
    { checkedAt: new Date(NOW + 1).toISOString() },
    { checkedAt: new Date(NOW - DAY_MS - 1).toISOString() },
    { firstNewerMinorAvailableAt: new Date(NOW + 1).toISOString() },
  ])('suppresses malformed, future, or stale timestamps: %j', (overrides) => {
    expect(stage(60 * DAY_MS, { release: release(60 * DAY_MS, overrides) })).toBeNull();
  });

  it('accepts metadata exactly 24 hours old and suppresses a missing release', () => {
    expect(
      stage(60 * DAY_MS, { release: release(60 * DAY_MS, { checkedAt: new Date(NOW - DAY_MS).toISOString() }) }),
    ).toBe('daily');
    expect(stage(60 * DAY_MS, { release: null })).toBeNull();
  });

  it('resets acknowledgment when the installed native version changes', () => {
    const acknowledgment = { nativeVersion: '2.6.0', lastAcknowledgedAtMs: NOW };
    expect(stage(60 * DAY_MS, { acknowledgment })).toBeNull();
    expect(stage(60 * DAY_MS, { acknowledgment, nativeVersion: '2.6.1' })).toBe('daily');
  });

  it('preserves release age when the target advances, without restarting the clock', () => {
    const firstRelease = release(60 * DAY_MS);
    const laterRelease = { ...firstRelease, latestVersion: '2.8.0' };
    expect(stage(60 * DAY_MS, { release: firstRelease })).toBe('daily');
    expect(stage(60 * DAY_MS, { release: laterRelease })).toBe('daily');
  });

  it.each([
    undefined,
    null,
    'invalid',
    [],
    { nativeVersion: 'unknown', lastAcknowledgedAtMs: NOW },
    { nativeVersion: '2.6.0', lastAcknowledgedAtMs: NaN },
    { nativeVersion: '2.6.0', lastAcknowledgedAtMs: -1 },
    { nativeVersion: '2.6.0', lastAcknowledgedAtMs: '123' },
  ])('rejects malformed persisted acknowledgment %j', (stored) => {
    expect(parseStoreUpdateAcknowledgment(stored)).toBeNull();
  });

  it('accepts a valid persisted acknowledgment and waits on a future acknowledgment', () => {
    const acknowledgment = { nativeVersion: '2.6.0', lastAcknowledgedAtMs: NOW + DAY_MS };
    expect(parseStoreUpdateAcknowledgment(acknowledgment)).toEqual(acknowledgment);
    expect(stage(60 * DAY_MS, { acknowledgment })).toBeNull();
  });
});

describe('local QA fixtures', () => {
  it.each(['weekly', 'frequent', 'daily'] as StoreUpdateStage[])(
    'forces only the requested %s stage in development',
    (expected) => {
      vi.stubGlobal('__DEV__', true);
      vi.stubEnv('EXPO_PUBLIC_STORE_UPDATE_QA_STAGE', expected);
      expect(readStoreUpdateQaStage()).toBe(expected);
      expect(
        getStoreUpdateStage({
          release: makeStoreUpdateQaRelease(expected, NOW),
          nativeVersion: '2.6.0',
          acknowledgment: null,
          nowMs: NOW,
        }),
      ).toBe(expected);
    },
  );

  it('rejects the force environment in production and invalid stages', () => {
    vi.stubGlobal('__DEV__', false);
    vi.stubEnv('EXPO_PUBLIC_STORE_UPDATE_QA_STAGE', 'daily');
    expect(readStoreUpdateQaStage()).toBeNull();
    vi.stubGlobal('__DEV__', true);
    vi.stubEnv('EXPO_PUBLIC_STORE_UPDATE_QA_STAGE', 'invalid');
    expect(readStoreUpdateQaStage()).toBeNull();
  });

  it('makes the current fixture a successful empty release', () => {
    vi.stubGlobal('__DEV__', true);
    vi.stubEnv('EXPO_PUBLIC_STORE_UPDATE_QA_STAGE', 'current');
    expect(readStoreUpdateQaStage()).toBe('current');
    expect(makeStoreUpdateQaRelease('current', NOW)).toBeNull();
  });
});
