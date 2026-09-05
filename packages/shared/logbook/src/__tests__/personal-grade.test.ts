import { describe, it, expect } from 'vitest';
import { pickLatestGradedTick, derivePersonalGradeDisplay, type GradedTickLike } from '../personal-grade';

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

describe('derivePersonalGradeDisplay', () => {
  it('falls through to the crowd when the climber never graded it', () => {
    expect(derivePersonalGradeDisplay(null, 'V4')).toEqual({
      source: 'crowd',
      markPrimary: false,
      secondaryLabel: null,
    });
  });

  it('treats an unfetched logbook exactly like an ungraded climb', () => {
    // Callers pass null for both "no grade" and "not known yet" — guessing
    // "no ticks" from an empty bucket is what caused #3940.
    expect(derivePersonalGradeDisplay(undefined, 'V4').source).toBe('crowd');
  });

  it('reports nothing to show when neither grade exists', () => {
    expect(derivePersonalGradeDisplay(null, null)).toEqual({
      source: 'none',
      markPrimary: false,
      secondaryLabel: null,
    });
  });

  it('shows your grade with no marker and no second line when you agree', () => {
    // State B: the row stays byte-identical to one with no personal grade.
    // ~85% of graded ticks agree, so this is the common graded case.
    expect(derivePersonalGradeDisplay('V4', 'V4')).toEqual({
      source: 'personal',
      markPrimary: false,
      secondaryLabel: null,
    });
  });

  it('treats different difficulty ids that render alike as agreement', () => {
    // Aurora 4a/4b/4c all render "V0". A climber who logged 4c on a climb
    // listed as 4a has not disagreed with anything a reader can see, so
    // showing them "V0 over V0" would be nonsense.
    expect(derivePersonalGradeDisplay('V0', 'V0').markPrimary).toBe(false);
  });

  it('marks your grade and demotes the crowd when you disagree', () => {
    expect(derivePersonalGradeDisplay('V10', 'V0')).toEqual({
      source: 'personal',
      markPrimary: true,
      secondaryLabel: 'V0',
    });
  });

  it('marks your grade with no second line when there is no crowd number', () => {
    // A draft, or an angle with no stats row. Still marked: the play drawer
    // is a screen people hand to their partner.
    expect(derivePersonalGradeDisplay('V7', null)).toEqual({
      source: 'personal',
      markPrimary: true,
      secondaryLabel: null,
    });
  });

  it('respects the climber grade-format preference by comparing labels', () => {
    // Same climb under the Font preference: agreement and disagreement must
    // read the same way they do under V-grades, with no id maths here.
    expect(derivePersonalGradeDisplay('7A', '7A').markPrimary).toBe(false);
    expect(derivePersonalGradeDisplay('7A', '6B').secondaryLabel).toBe('6B');
  });
});
