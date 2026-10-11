import { describe, it, expect } from 'vitest';
import {
  pickLatestGradedTick,
  clampToBoulderScale,
  BOULDER_SCALE_MIN_ID,
  BOULDER_SCALE_MAX_ID,
  type GradedTickLike,
} from '../personal-grade';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';

function tick(overrides: Partial<GradedTickLike> & Pick<GradedTickLike, 'uuid'>): GradedTickLike {
  return { difficulty: 20, climbed_at: '2026-01-01T00:00:00.000Z', ...overrides };
}

describe('pickLatestGradedTick', () => {
  it('returns null for an empty or absent bucket', () => {
    expect(pickLatestGradedTick([])).toBeNull();
    expect(pickLatestGradedTick(undefined)).toBeNull();
  });

  it('returns null when no tick in the bucket carries a grade', () => {
    const ungraded = [
      tick({ uuid: 'a', difficulty: null }),
      tick({ uuid: 'b', difficulty: null, climbed_at: '2026-05-01T00:00:00.000Z' }),
    ];
    expect(pickLatestGradedTick(ungraded)).toBeNull();
  });

  it('treats difficulty 0 as a real grade, not a falsy miss', () => {
    const picked = pickLatestGradedTick([tick({ uuid: 'a', difficulty: 0 })]);
    expect(picked?.difficulty).toBe(0);
  });

  it('takes the newest grade rather than the hardest', () => {
    // A stiff grade from one bad day must not stick forever — #4796's
    // maintainer framing is "their last estimate of the grade".
    const entries = [
      tick({ uuid: 'old', difficulty: 30, climbed_at: '2025-03-01T00:00:00.000Z' }),
      tick({ uuid: 'new', difficulty: 14, climbed_at: '2026-08-01T00:00:00.000Z' }),
    ];
    expect(pickLatestGradedTick(entries)?.uuid).toBe('new');
  });

  it('ignores array order, which is not chronological in a real bucket', () => {
    // mergeLogbookEntries APPENDS each fetched page while an optimistic save
    // PREPENDS, so entries[0] is not the latest. Same data, three orders.
    const older = tick({ uuid: 'older', difficulty: 12, climbed_at: '2026-01-01T00:00:00.000Z' });
    const newer = tick({ uuid: 'newer', difficulty: 18, climbed_at: '2026-09-01T00:00:00.000Z' });
    const middle = tick({ uuid: 'middle', difficulty: 15, climbed_at: '2026-05-01T00:00:00.000Z' });

    expect(pickLatestGradedTick([older, newer, middle])?.uuid).toBe('newer');
    expect(pickLatestGradedTick([newer, older, middle])?.uuid).toBe('newer');
    expect(pickLatestGradedTick([middle, older, newer])?.uuid).toBe('newer');
  });

  it('skips an ungraded attempt sitting among graded ticks', () => {
    const entries = [
      tick({ uuid: 'graded', difficulty: 17, climbed_at: '2026-02-01T00:00:00.000Z' }),
      tick({ uuid: 'attempt', difficulty: null, climbed_at: '2026-09-01T00:00:00.000Z' }),
    ];
    // The attempt is newer, but it carries no opinion to adopt.
    expect(pickLatestGradedTick(entries)?.uuid).toBe('graded');
  });

  it('breaks an identical-timestamp tie on uuid, the only key the client also has', () => {
    // The server orders (climbed_at DESC, uuid DESC) for exactly this reason:
    // boardsesh_ticks.id never reaches the client, so ordering on it would let
    // the two sides disagree about which grade is current.
    const sameInstant = '2026-06-01T12:00:00.000Z';
    const entries = [
      tick({ uuid: 'aaa', difficulty: 12, climbed_at: sameInstant }),
      tick({ uuid: 'zzz', difficulty: 20, climbed_at: sameInstant }),
    ];
    expect(pickLatestGradedTick(entries)?.uuid).toBe('zzz');
    expect(pickLatestGradedTick([...entries].reverse())?.uuid).toBe('zzz');
  });

  it('stays total when a legacy row carries an unparseable timestamp', () => {
    // #3909 left rows with inconsistent timezone labelling; the comparator
    // falls back to a lexical compare rather than ordering NaN arbitrarily.
    const entries = [
      tick({ uuid: 'a', difficulty: 12, climbed_at: 'not-a-date' }),
      tick({ uuid: 'b', difficulty: 20, climbed_at: '2026-06-01T00:00:00.000Z' }),
    ];
    expect(pickLatestGradedTick(entries)).not.toBeNull();
    expect(pickLatestGradedTick([...entries].reverse())?.uuid).toBe(pickLatestGradedTick(entries)?.uuid);
  });
});

/**
 * The display half and the query half have to agree on the NUMBER, not just on
 * which tick is latest. The server clamps in SQL before it filters and sorts;
 * a display path that showed the raw id would put a row on screen reading one
 * grade while the list placed it by another — the exact defect #4828 closes.
 * Writes are bounded today, so only a legacy or imported row can trip this.
 */
describe('clampToBoulderScale', () => {
  it('derives its bounds from BOULDER_GRADES rather than hardcoding them', () => {
    expect(BOULDER_SCALE_MIN_ID).toBe(BOULDER_GRADES[0].difficulty_id);
    expect(BOULDER_SCALE_MAX_ID).toBe(BOULDER_GRADES[BOULDER_GRADES.length - 1].difficulty_id);
  });

  it('leaves an on-scale grade exactly as it is', () => {
    expect(clampToBoulderScale(BOULDER_SCALE_MIN_ID)).toBe(BOULDER_SCALE_MIN_ID);
    expect(clampToBoulderScale(BOULDER_SCALE_MAX_ID)).toBe(BOULDER_SCALE_MAX_ID);
    expect(clampToBoulderScale(27)).toBe(27);
  });

  it('pulls an out-of-scale legacy or imported grade onto the scale', () => {
    // A tick that predates the write-side bound, or came in through a JSON
    // import. It belongs in the top band, not nowhere.
    expect(clampToBoulderScale(99)).toBe(BOULDER_SCALE_MAX_ID);
    // 0 is a real difficulty id in Aurora's numbering but below this scale's
    // floor, so it clamps up rather than reading as "ungraded".
    expect(clampToBoulderScale(0)).toBe(BOULDER_SCALE_MIN_ID);
    expect(clampToBoulderScale(-5)).toBe(BOULDER_SCALE_MIN_ID);
  });

  it('passes null and undefined through — no grade is not a grade to clamp', () => {
    expect(clampToBoulderScale(null)).toBeNull();
    expect(clampToBoulderScale(undefined)).toBeNull();
  });

  it('clamps the tick pickLatestGradedTick hands back, end to end', () => {
    const latest = pickLatestGradedTick([
      tick({ uuid: 'a', difficulty: 99, climbed_at: '2026-02-01T00:00:00.000Z' }),
      tick({ uuid: 'b', difficulty: 20, climbed_at: '2026-01-01T00:00:00.000Z' }),
    ]);

    expect(latest?.difficulty).toBe(99);
    expect(clampToBoulderScale(latest?.difficulty ?? null)).toBe(BOULDER_SCALE_MAX_ID);
  });
});
