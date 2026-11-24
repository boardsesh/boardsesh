import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbStatsEvent } from '@boardsesh/shared-schema';
import {
  acknowledgeOptimisticAscent,
  applyCanonicalClimbStats,
  beginOptimisticAscent,
  getAcknowledgedClimbStatsTokens,
  getClimbStatsRefCount,
  getClimbStatsSnapshot,
  markClimbPlaysUnavailable,
  markOptimisticAscentQueued,
  rejectOptimisticAscent,
  resetClimbStatsStoreForTests,
  setClimbStatsAuthEpoch,
  settleOfflineTickAscent,
  subscribeClimbStats,
  type ClimbStatsKey,
} from '../climb-stats-store';

const key: ClimbStatsKey = {
  boardType: 'kilter',
  layoutId: 1,
  climbUuid: 'climb-1',
  angle: 40,
};

function canonical(syncSeq: string, ascensionistCount: number, overrides?: Partial<ClimbStatsEvent>): ClimbStatsEvent {
  return {
    ...key,
    ascensionistCount,
    qualityAverage: 3.5,
    difficultyAverage: 19.2,
    displayDifficulty: 19,
    difficulty: '6c/V5',
    faUsername: 'setter',
    faAt: '2026-08-01T00:00:00.000Z',
    syncSeq,
    ...overrides,
  };
}

describe('climb stats external store', () => {
  beforeEach(() => resetClimbStatsStoreForTests());

  it('uses decimal BigInt revisions and drops stale, duplicate, and invalid events', () => {
    const unsubscribe = subscribeClimbStats(key, vi.fn());
    expect(applyCanonicalClimbStats(canonical('90071992547409930', 10))).toBe(true);
    expect(applyCanonicalClimbStats(canonical('90071992547409929', 9))).toBe(false);
    expect(applyCanonicalClimbStats(canonical('90071992547409930', 11))).toBe(false);
    expect(applyCanonicalClimbStats(canonical('1e20', 12))).toBe(false);
    expect(getClimbStatsSnapshot(key).canonical?.ascensionistCount).toBe(10);
    unsubscribe();
  });

  it('orders missing and present Plays observations independently from the grade stream', () => {
    const release = subscribeClimbStats(key, vi.fn());
    const row = canonical('12', 3);
    const count = () => getClimbStatsSnapshot(key).plays?.playCount;
    const received = (dispatchOrder: number, playCount: number | null, stats = row) =>
      applyCanonicalClimbStats(stats, { dispatchOrder, playCount, authEpoch: 0 });
    const omitted = (dispatchOrder: number) => markClimbPlaysUnavailable(key, { dispatchOrder, authEpoch: 0 });

    applyCanonicalClimbStats(canonical('13', 4)); // A tick event overtook the read.
    received(2, 25);
    expect(count()).toBe(25);
    omitted(1);
    expect(count()).toBe(25);
    applyCanonicalClimbStats(canonical('14', 5));
    expect(count()).toBe(25);

    omitted(4); // The same viewer lost resource visibility.
    expect(count()).toBeNull();
    received(3, 50, canonical('15', 6));
    expect(count()).toBeNull();
    received(5, 18, canonical('11', 0));
    expect(count()).toBeNull();
    received(6, 0);
    expect(count()).toBe(0);
    omitted(7);
    expect(count()).toBeNull();
    received(8, 0);
    expect(count()).toBe(0);
    received(9, null, canonical('16', 5));
    expect(count()).toBeNull();
    expect(getClimbStatsSnapshot(key).canonical?.ascensionistCount).toBe(5);
    release();
  });

  it('wipes retained Plays across credential changes and rejects an old-epoch read', () => {
    const release = subscribeClimbStats(key, vi.fn());
    const sameClimbOtherLayout = { ...key, layoutId: 2, angle: 30 };
    const releaseOther = subscribeClimbStats(sameClimbOtherLayout, vi.fn());
    applyCanonicalClimbStats(canonical('10', 1), { dispatchOrder: 1, playCount: 25, authEpoch: 0 });
    expect(getClimbStatsSnapshot(sameClimbOtherLayout).plays).toBeUndefined();
    setClimbStatsAuthEpoch(1);
    applyCanonicalClimbStats(canonical('11', 2), { dispatchOrder: 2, playCount: 100, authEpoch: 0 });
    markClimbPlaysUnavailable(key, { dispatchOrder: 3, authEpoch: 0 });
    expect(getClimbStatsSnapshot(key).plays).toBeUndefined();
    applyCanonicalClimbStats(canonical('11', 2), { dispatchOrder: 4, playCount: 0, authEpoch: 1 });
    expect(getClimbStatsSnapshot(key).plays).toEqual({ playCount: 0, authEpoch: 1 });
    release();
    releaseOther();
  });

  it('does not cache or notify an unrelated exact-key event', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeClimbStats(key, listener);
    const unrelated = canonical('1', 5, { climbUuid: 'climb-2' });
    expect(applyCanonicalClimbStats(unrelated)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(getClimbStatsSnapshot(key).canonical).toBeNull();
    unsubscribe();
  });

  it('keeps concurrent first-send mutations at one floor and rolls back independently', () => {
    setClimbStatsAuthEpoch(7);
    const unsubscribe = subscribeClimbStats(key, vi.fn());
    beginOptimisticAscent(key, 'mutation-a', 7, 10);
    beginOptimisticAscent(key, 'mutation-b', 7, 10);
    expect(getClimbStatsSnapshot(key).optimisticFloor).toBe(11);

    rejectOptimisticAscent('mutation-a', 7);
    expect(getClimbStatsSnapshot(key).optimisticFloor).toBe(11);
    rejectOptimisticAscent('mutation-b', 7);
    expect(getClimbStatsSnapshot(key).optimisticFloor).toBeNull();
    unsubscribe();
  });

  it('turns a normalized zero base into a finite optimistic floor of one', () => {
    setClimbStatsAuthEpoch(7);
    const unsubscribe = subscribeClimbStats(key, vi.fn());
    beginOptimisticAscent(key, 'first-ascent', 7, 0);

    const optimisticFloor = getClimbStatsSnapshot(key).optimisticFloor;
    expect(optimisticFloor).toBe(1);
    expect(Number.isFinite(optimisticFloor)).toBe(true);
    unsubscribe();
  });

  it('floors from the immutable mutation base without incrementing a newer canonical snapshot', () => {
    setClimbStatsAuthEpoch(7);
    const unsubscribe = subscribeClimbStats(key, vi.fn());
    applyCanonicalClimbStats(canonical('1', 12));

    beginOptimisticAscent(key, 'mutation-a', 7, 10);
    beginOptimisticAscent(key, 'mutation-b', 7, 10);

    // max(canonical 12, immutable base 10 + 1), never canonical + 1 or +2.
    expect(getClimbStatsSnapshot(key).optimisticFloor).toBe(12);
    unsubscribe();
  });

  it('retires an acknowledged floor only after canonical catches it, including event-before-ack', () => {
    setClimbStatsAuthEpoch(4);
    const unsubscribe = subscribeClimbStats(key, vi.fn());
    beginOptimisticAscent(key, 'mutation-a', 4, 10);
    applyCanonicalClimbStats(canonical('2', 11));
    expect(getClimbStatsSnapshot(key).optimisticFloor).toBe(11);

    acknowledgeOptimisticAscent('mutation-a', 4);
    expect(getClimbStatsSnapshot(key)).toEqual({
      canonical: canonical('2', 11),
      optimisticFloor: null,
    });
    unsubscribe();
  });

  it('snapshots exact acknowledged repair obligations by board, climb, and auth epoch', () => {
    setClimbStatsAuthEpoch(4);
    beginOptimisticAscent(key, 'acknowledged-first', 4, 10);
    acknowledgeOptimisticAscent('acknowledged-first', 4);
    beginOptimisticAscent(key, 'still-pending', 4, 20);
    const captured = getAcknowledgedClimbStatsTokens('kilter', 'climb-1', 4);

    acknowledgeOptimisticAscent('still-pending', 4);
    beginOptimisticAscent({ ...key, climbUuid: 'climb-2' }, 'other-climb', 4, 30);
    acknowledgeOptimisticAscent('other-climb', 4);

    expect(captured).toEqual(['acknowledged-first']);
    expect(getAcknowledgedClimbStatsTokens('kilter', 'climb-1', 4)).toEqual(['acknowledged-first', 'still-pending']);
    expect(getAcknowledgedClimbStatsTokens('kilter', 'climb-2', 4)).toEqual(['other-climb']);
    expect(getAcknowledgedClimbStatsTokens('kilter', 'climb-1', 3)).toEqual([]);
  });

  it('bridges queued tick acknowledgements and dead letters by tick UUID', () => {
    setClimbStatsAuthEpoch(2);
    const unsubscribe = subscribeClimbStats(key, vi.fn());
    beginOptimisticAscent(key, 'queued-a', 2, 20);
    markOptimisticAscentQueued('queued-a', 'tick-a', 2);
    expect(settleOfflineTickAscent('tick-a', 'acknowledged', 2)).toEqual({
      key,
      token: 'queued-a',
      status: 'acknowledged',
    });
    expect(getClimbStatsSnapshot(key).optimisticFloor).toBe(21);
    applyCanonicalClimbStats(canonical('5', 21));
    expect(getClimbStatsSnapshot(key).optimisticFloor).toBeNull();

    beginOptimisticAscent(key, 'queued-b', 2, 21);
    markOptimisticAscentQueued('queued-b', 'tick-b', 2);
    expect(settleOfflineTickAscent('tick-b', 'dead_letter', 2)).toEqual({
      key,
      token: 'queued-b',
      status: 'dead_letter',
    });
    expect(getClimbStatsSnapshot(key).optimisticFloor).toBeNull();
    unsubscribe();
  });

  it('closes the eager-drain race when acknowledgement arrives before UUID mapping', () => {
    setClimbStatsAuthEpoch(2);
    const unsubscribe = subscribeClimbStats(key, vi.fn());
    beginOptimisticAscent(key, 'queued-a', 2, 4);
    expect(settleOfflineTickAscent('tick-a', 'acknowledged', 2)).toBeNull();
    expect(markOptimisticAscentQueued('queued-a', 'tick-a', 2)).toEqual({
      key,
      token: 'queued-a',
      status: 'acknowledged',
    });
    applyCanonicalClimbStats(canonical('2', 5));
    expect(getClimbStatsSnapshot(key).optimisticFloor).toBeNull();
    unsubscribe();
  });

  it('clears old-auth optimism and balances StrictMode-style subscribe cleanup', () => {
    setClimbStatsAuthEpoch(1);
    const cleanupFirst = subscribeClimbStats(key, vi.fn());
    const cleanupSecond = subscribeClimbStats(key, vi.fn());
    expect(getClimbStatsRefCount(key)).toBe(2);
    beginOptimisticAscent(key, 'mutation-a', 1, 3);
    setClimbStatsAuthEpoch(2);
    expect(getClimbStatsSnapshot(key).optimisticFloor).toBeNull();
    beginOptimisticAscent(key, 'stale-mutation', 1, 3);
    expect(getClimbStatsSnapshot(key).optimisticFloor).toBeNull();

    cleanupFirst();
    expect(getClimbStatsRefCount(key)).toBe(1);
    cleanupSecond();
    expect(getClimbStatsRefCount(key)).toBe(0);
  });
});
