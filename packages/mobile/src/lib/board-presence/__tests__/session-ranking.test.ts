import { describe, it, expect } from 'vitest';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { computeSessionRanking } from '../session-ranking';

// computeSessionRanking only reads the sender + seq fields, so a partial cast
// keeps the fixtures readable without stubbing the whole BoardPresenceClimb shape.
function climb(fields: {
  sentByUserId?: string | null;
  sentByDisplayName?: string | null;
  sentByAvatarUrl?: string | null;
  seq: number;
}): BoardPresenceClimb {
  return fields as unknown as BoardPresenceClimb;
}

describe('computeSessionRanking', () => {
  it('groups sends by climber and ranks by send count', () => {
    const ranking = computeSessionRanking([
      climb({ sentByUserId: 'u1', sentByDisplayName: 'Ana', seq: 1 }),
      climb({ sentByUserId: 'u2', sentByDisplayName: 'Bo', seq: 2 }),
      climb({ sentByUserId: 'u1', sentByDisplayName: 'Ana', seq: 3 }),
    ]);
    expect(ranking.map((entry) => [entry.displayName, entry.sendCount])).toEqual([
      ['Ana', 2],
      ['Bo', 1],
    ]);
  });

  it('breaks send-count ties toward the most recent send (highest seq)', () => {
    const ranking = computeSessionRanking([
      climb({ sentByUserId: 'u1', sentByDisplayName: 'Ana', seq: 1 }),
      climb({ sentByUserId: 'u2', sentByDisplayName: 'Bo', seq: 5 }),
    ]);
    expect(ranking.map((entry) => entry.displayName)).toEqual(['Bo', 'Ana']);
    expect(ranking[0].latestSeq).toBe(5);
  });

  it('skips anonymous sends with no display name', () => {
    const ranking = computeSessionRanking([
      climb({ sentByUserId: null, sentByDisplayName: null, seq: 1 }),
      climb({ sentByUserId: null, sentByDisplayName: '   ', seq: 2 }),
      climb({ sentByUserId: 'u1', sentByDisplayName: 'Ana', seq: 3 }),
    ]);
    expect(ranking).toHaveLength(1);
    expect(ranking[0].displayName).toBe('Ana');
  });

  it('groups userless climbers by trimmed display name', () => {
    const ranking = computeSessionRanking([
      climb({ sentByUserId: null, sentByDisplayName: 'Guest', seq: 1 }),
      climb({ sentByUserId: null, sentByDisplayName: 'Guest', seq: 2 }),
    ]);
    expect(ranking).toHaveLength(1);
    expect(ranking[0].sendCount).toBe(2);
    expect(ranking[0].userId).toBeNull();
  });

  it('caps the leaderboard at the limit', () => {
    const history = Array.from({ length: 8 }, (_unused, index) =>
      climb({ sentByUserId: `u${index}`, sentByDisplayName: `C${index}`, seq: index }),
    );
    expect(computeSessionRanking(history, 3)).toHaveLength(3);
  });

  it('returns an empty ranking for an empty history', () => {
    expect(computeSessionRanking([])).toEqual([]);
  });
});
