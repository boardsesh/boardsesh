import { describe, expect, it } from 'vitest';
import type { BoardLeaderboard, BoardLeaderboardEntry } from '@boardsesh/shared-schema';
import { mergePeriodLeaderboards, mergeSettledPeriodLeaderboards } from '../leaderboard-rail/leaderboard-model';

describe('anonymous climbers in the period merge', () => {
  it('merges an anonymous climber across boards by their stable pseudonym and keeps the name null', () => {
    // The backend sends `anon:<hmac>` instead of the real user id for a climber
    // who opted out of being named on gym screens. It is stable per climber, so
    // the cross-board merge still sums their sends into one row rather than
    // splitting them — and a null displayName is what makes the rail render its
    // localized "anonymous" fallback instead of a blank cell.
    const anonId = 'anon:VGhpc0lzQVN0YWJsZUht';
    const merged = mergePeriodLeaderboards([
      makeLeaderboard('board-1', [
        makeEntry({ userId: anonId, isAnonymous: true, userDisplayName: null, totalSends: 4 }),
      ]),
      makeLeaderboard('board-2', [
        makeEntry({ userId: anonId, isAnonymous: true, userDisplayName: null, totalSends: 3 }),
      ]),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ key: `user:${anonId}`, displayName: null, sendCount: 7 });
  });

  it('does not fuse two different anonymous climbers into one row', () => {
    const merged = mergePeriodLeaderboards([
      makeLeaderboard('board-1', [
        makeEntry({ userId: 'anon:aaaaaaaaaaaaaaaaaaaaaa', isAnonymous: true, userDisplayName: null, totalSends: 4 }),
        makeEntry({ userId: 'anon:bbbbbbbbbbbbbbbbbbbbbb', isAnonymous: true, userDisplayName: null, totalSends: 2 }),
      ]),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map((row) => row.sendCount)).toEqual([4, 2]);
  });
});

function makeEntry(overrides: Partial<BoardLeaderboardEntry> & { userId: string | null }): BoardLeaderboardEntry {
  return {
    rank: 1,
    totalSends: 1,
    totalFlashes: 0,
    totalSessions: 1,
    // Named by default; the anonymous case below overrides this and drops the name.
    isAnonymous: false,
    ...overrides,
  };
}

function makeLeaderboard(boardUuid: string, entries: BoardLeaderboardEntry[]): BoardLeaderboard {
  return { boardUuid, entries, totalCount: entries.length, hasMore: false, periodLabel: 'This Week' };
}

describe('mergePeriodLeaderboards', () => {
  it('keeps hardest grade in single-board scope', () => {
    const rows = mergePeriodLeaderboards([
      makeLeaderboard('board-a', [
        makeEntry({ userId: 'user-1', userDisplayName: 'Ada', totalSends: 5, hardestGradeName: 'V8' }),
      ]),
    ]);
    expect(rows[0]).toMatchObject({ key: 'user:user-1', sendCount: 5, hardestGradeName: 'V8' });
  });

  it('merges multi-board results by user, summing sends and dropping hardest grade', () => {
    const rows = mergePeriodLeaderboards([
      makeLeaderboard('board-a', [
        makeEntry({ userId: 'user-1', userDisplayName: 'Ada', totalSends: 5, hardestGradeName: 'V8' }),
        makeEntry({ userId: 'user-2', userDisplayName: 'Ben', totalSends: 2, hardestGradeName: 'V4' }),
      ]),
      makeLeaderboard('board-b', [
        makeEntry({ userId: 'user-2', userDisplayName: 'Ben', totalSends: 6, hardestGradeName: 'V6' }),
      ]),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ key: 'user:user-2', sendCount: 8, hardestGradeName: null });
    expect(rows[1]).toMatchObject({ key: 'user:user-1', sendCount: 5, hardestGradeName: null });
  });

  it('folds anonymous climbers into one unnamed row instead of a list of pseudonyms', () => {
    // The backend sends a private climber, or one who stays anonymous on boards
    // they don't own, with no user id or name. Totals still count them.
    const rows = mergePeriodLeaderboards([
      makeLeaderboard('board-a', [
        makeEntry({ userId: 'user-1', userDisplayName: 'Ada', totalSends: 3 }),
        makeEntry({ userId: null, totalSends: 4 }),
        makeEntry({ userId: null, totalSends: 2 }),
      ]),
      makeLeaderboard('board-b', [makeEntry({ userId: null, totalSends: 1 })]),
    ]);
    expect(rows).toEqual([
      { key: 'private-climbers', displayName: null, avatarUrl: null, sendCount: 7, hardestGradeName: null },
      { key: 'user:user-1', displayName: 'Ada', avatarUrl: null, sendCount: 3, hardestGradeName: null },
    ]);
  });

  it('fills missing display name/avatar from a later board entry', () => {
    const rows = mergePeriodLeaderboards([
      makeLeaderboard('board-a', [makeEntry({ userId: 'user-1', totalSends: 1 })]),
      makeLeaderboard('board-b', [
        makeEntry({ userId: 'user-1', userDisplayName: 'Ada', userAvatarUrl: 'https://example.com/a.png' }),
      ]),
    ]);
    expect(rows[0]).toMatchObject({ displayName: 'Ada', avatarUrl: 'https://example.com/a.png', sendCount: 2 });
  });

  it('caps merged rows at 10 and sorts deterministically on ties', () => {
    const manyEntries = Array.from({ length: 12 }, (_, index) =>
      makeEntry({ userId: `user-${String(index).padStart(2, '0')}`, totalSends: 3 }),
    );
    const rows = mergePeriodLeaderboards([makeLeaderboard('board-a', manyEntries)]);
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => row.key)).toEqual(rows.map((row) => row.key).sort());
  });
});

function fulfilled(leaderboard: BoardLeaderboard): PromiseFulfilledResult<{ boardLeaderboard: BoardLeaderboard }> {
  return { status: 'fulfilled', value: { boardLeaderboard: leaderboard } };
}

function rejected(): PromiseRejectedResult {
  return { status: 'rejected', reason: new Error('board fetch failed') };
}

describe('mergeSettledPeriodLeaderboards', () => {
  it('throws when EVERY board fetch failed (rail shows unavailable, not fake-empty)', () => {
    expect(() => mergeSettledPeriodLeaderboards([rejected(), rejected()])).toThrow(/all board fetches failed/);
  });

  it('narrows to the boards that answered on partial failure', () => {
    const rows = mergeSettledPeriodLeaderboards([
      fulfilled(makeLeaderboard('board-a', [makeEntry({ userId: 'user-1', totalSends: 4 })])),
      rejected(),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'user:user-1', sendCount: 4 });
  });

  it('treats zero scoped boards as an empty ranking, not an error', () => {
    expect(mergeSettledPeriodLeaderboards([])).toEqual([]);
  });

  it('still merges across boards when all succeed', () => {
    const rows = mergeSettledPeriodLeaderboards([
      fulfilled(makeLeaderboard('board-a', [makeEntry({ userId: 'user-1', totalSends: 2 })])),
      fulfilled(makeLeaderboard('board-b', [makeEntry({ userId: 'user-1', totalSends: 3 })])),
    ]);
    expect(rows[0]).toMatchObject({ key: 'user:user-1', sendCount: 5, hardestGradeName: null });
  });
});
