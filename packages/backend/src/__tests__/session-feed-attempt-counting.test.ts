import { describe, it, expect } from 'vitest';
import {
  buildGradeDistributionFromTicks,
  computeSessionAggregates,
} from '../graphql/resolvers/social/session-feed-utils';

function makeTick(
  status: string,
  attemptCount: number,
  difficulty: number | null = 10,
  boardType = 'kilter',
) {
  return { tick: { status, attemptCount, difficulty, boardType }, difficultyName: difficulty != null ? `V${difficulty}` : null };
}

describe('computeSessionAggregates', () => {
  it('counts flash as both a send and a flash with 0 attempts', () => {
    const result = computeSessionAggregates([makeTick('flash', 1)]);
    expect(result).toEqual({ totalSends: 1, totalFlashes: 1, totalAttempts: 0 });
  });

  it('counts send with attemptCount=1 as 0 additional attempts', () => {
    const result = computeSessionAggregates([makeTick('send', 1)]);
    expect(result).toEqual({ totalSends: 1, totalFlashes: 0, totalAttempts: 0 });
  });

  it('counts send with attemptCount=3 as 2 failed attempts', () => {
    const result = computeSessionAggregates([makeTick('send', 3)]);
    expect(result).toEqual({ totalSends: 1, totalFlashes: 0, totalAttempts: 2 });
  });

  it('counts explicit attempt status using attemptCount', () => {
    const result = computeSessionAggregates([makeTick('attempt', 5)]);
    expect(result).toEqual({ totalSends: 0, totalFlashes: 0, totalAttempts: 5 });
  });

  it('aggregates mixed tick types correctly', () => {
    const rows = [
      makeTick('flash', 1),   // 1 send, 1 flash, 0 attempts
      makeTick('send', 3),    // 1 send, 0 flash, 2 attempts
      makeTick('send', 1),    // 1 send, 0 flash, 0 attempts
      makeTick('attempt', 2), // 0 send, 0 flash, 2 attempts
    ];
    const result = computeSessionAggregates(rows);
    expect(result).toEqual({ totalSends: 3, totalFlashes: 1, totalAttempts: 4 });
  });

  it('returns zeros for empty input', () => {
    const result = computeSessionAggregates([]);
    expect(result).toEqual({ totalSends: 0, totalFlashes: 0, totalAttempts: 0 });
  });
});

describe('buildGradeDistributionFromTicks', () => {
  it('groups ticks by grade and counts flash/send/attempt correctly', () => {
    const rows = [
      makeTick('flash', 1, 10),
      makeTick('send', 3, 10),
      makeTick('attempt', 2, 10),
    ];
    const result = buildGradeDistributionFromTicks(rows);
    expect(result).toEqual([
      { grade: 'V10', difficulty: 10, flash: 1, send: 1, attempt: 4 }, // 2 from send (3-1) + 2 from attempt
    ]);
  });

  it('separates different grades', () => {
    const rows = [
      makeTick('flash', 1, 5),
      makeTick('send', 2, 10),
    ];
    const result = buildGradeDistributionFromTicks(rows);
    // Sorted by difficulty descending
    expect(result).toEqual([
      { grade: 'V10', difficulty: 10, flash: 0, send: 1, attempt: 1 },
      { grade: 'V5', difficulty: 5, flash: 1, send: 0, attempt: 0 },
    ]);
  });

  it('send with attemptCount=1 adds 0 attempts', () => {
    const rows = [makeTick('send', 1, 5)];
    const result = buildGradeDistributionFromTicks(rows);
    expect(result).toEqual([
      { grade: 'V5', difficulty: 5, flash: 0, send: 1, attempt: 0 },
    ]);
  });

  it('skips rows with null difficulty or missing difficultyName', () => {
    const rows = [
      makeTick('send', 1, null),
      { tick: { status: 'send', attemptCount: 1, difficulty: 5, boardType: 'kilter' }, difficultyName: null },
    ];
    const result = buildGradeDistributionFromTicks(rows);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    const result = buildGradeDistributionFromTicks([]);
    expect(result).toEqual([]);
  });

  it('sorts grades from hardest to easiest (descending difficulty)', () => {
    const rows = [
      makeTick('flash', 1, 3),
      makeTick('flash', 1, 8),
      makeTick('flash', 1, 5),
    ];
    const result = buildGradeDistributionFromTicks(rows);
    expect(result.map((g) => g.grade)).toEqual(['V8', 'V5', 'V3']);
  });
});
