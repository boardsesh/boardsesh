import { describe, it, expect } from 'vitest';
import { deriveLogbookGradeDisplay, resolveCrowdDifficulty, resolveGradeErrorBadge } from '../grade-display';

describe('deriveLogbookGradeDisplay', () => {
  it('shows no consensus secondary when the logged grade matches the consensus', () => {
    expect(deriveLogbookGradeDisplay(10, 10)).toEqual({ showConsensusSecondary: false, gradeIsConsensus: false });
  });

  it('shows the consensus secondary when the logged grade differs from the consensus', () => {
    expect(deriveLogbookGradeDisplay(8, 9)).toEqual({ showConsensusSecondary: true, gradeIsConsensus: false });
  });

  it('marks the grade as consensus-sourced for an ungraded tick that has a consensus', () => {
    expect(deriveLogbookGradeDisplay(null, 9)).toEqual({ showConsensusSecondary: false, gradeIsConsensus: true });
    expect(deriveLogbookGradeDisplay(undefined, 9)).toEqual({ showConsensusSecondary: false, gradeIsConsensus: true });
  });

  it('shows neither when there is no consensus to compare against', () => {
    expect(deriveLogbookGradeDisplay(null, null)).toEqual({ showConsensusSecondary: false, gradeIsConsensus: false });
    expect(deriveLogbookGradeDisplay(10, null)).toEqual({ showConsensusSecondary: false, gradeIsConsensus: false });
  });
});

describe('resolveCrowdDifficulty', () => {
  it('returns the legacy consensus when the toggle is off, ignoring the Boardsesh grade', () => {
    expect(
      resolveCrowdDifficulty(
        { boardseshDifficulty: 18.4, boardseshConfidence: 'confirmed', consensusDifficulty: 15 },
        false,
      ),
    ).toBe(15);
  });

  it('returns the rounded Boardsesh grade when the toggle is on and it is trusted', () => {
    expect(
      resolveCrowdDifficulty(
        { boardseshDifficulty: 18.4, boardseshConfidence: 'confirmed', consensusDifficulty: 15 },
        true,
      ),
    ).toBe(18);
    // Rounds up at .5+.
    expect(
      resolveCrowdDifficulty(
        { boardseshDifficulty: 17.6, boardseshConfidence: 'provisional', consensusDifficulty: 15 },
        true,
      ),
    ).toBe(18);
  });

  it('falls back to the consensus for a setter_only Boardsesh grade even with the toggle on', () => {
    expect(
      resolveCrowdDifficulty(
        { boardseshDifficulty: 18.4, boardseshConfidence: 'setter_only', consensusDifficulty: 15 },
        true,
      ),
    ).toBe(15);
  });

  it('falls back to the consensus when the Boardsesh grade is null with the toggle on', () => {
    expect(
      resolveCrowdDifficulty(
        { boardseshDifficulty: null, boardseshConfidence: 'confirmed', consensusDifficulty: 15 },
        true,
      ),
    ).toBe(15);
    expect(resolveCrowdDifficulty({ boardseshDifficulty: undefined, consensusDifficulty: 15 }, true)).toBe(15);
  });

  it('returns null when neither a trusted Boardsesh grade nor a consensus is available', () => {
    expect(resolveCrowdDifficulty({ boardseshDifficulty: null, consensusDifficulty: null }, true)).toBeNull();
    expect(resolveCrowdDifficulty({ boardseshDifficulty: null, consensusDifficulty: undefined }, true)).toBeNull();
    // Toggle off + no consensus → null too.
    expect(resolveCrowdDifficulty({ boardseshDifficulty: 18, boardseshConfidence: 'confirmed' }, false)).toBeNull();
  });

  it('treats a zero Boardsesh grade as present (not falsy-skipped)', () => {
    // Guards against a `!boardseshDifficulty` bug: 0 is a real grade id.
    expect(
      resolveCrowdDifficulty(
        { boardseshDifficulty: 0, boardseshConfidence: 'confirmed', consensusDifficulty: 15 },
        true,
      ),
    ).toBe(0);
  });

  it('uses a present grade with an undefined confidence (blocklist, not allowlist)', () => {
    // The DB guarantees confidence is set whenever a grade row exists, so this
    // shouldn't happen with real data — but the guard is a blocklist
    // (`!== 'setter_only'`) on purpose, so an unset/unrecognized tier still
    // surfaces the grade instead of being silently dropped. See the comment
    // on the guard in grade-display.ts.
    expect(resolveCrowdDifficulty({ boardseshDifficulty: 18, boardseshConfidence: undefined }, true)).toBe(18);
  });
});

describe('resolveGradeErrorBadge', () => {
  it('flags a climb as stiff when the crowd average runs harder than the display grade', () => {
    expect(resolveGradeErrorBadge(0.7, 10)).toEqual({ direction: 'stiff', amount: 0.7 });
  });

  it('flags a climb as soft when the crowd average runs easier than the display grade', () => {
    expect(resolveGradeErrorBadge(-0.6, 10)).toEqual({ direction: 'soft', amount: 0.6 });
  });

  it('parses a string difficulty_error, the shape the wire format carries', () => {
    expect(resolveGradeErrorBadge('0.55', 10)).toEqual({ direction: 'stiff', amount: 0.55 });
    expect(resolveGradeErrorBadge('-0.55', 10)).toEqual({ direction: 'soft', amount: 0.55 });
  });

  it('returns null below the notability threshold, even with plenty of ascents', () => {
    expect(resolveGradeErrorBadge(0.2, 100)).toBeNull();
    expect(resolveGradeErrorBadge(-0.49, 100)).toBeNull();
  });

  it('returns null below the minimum ascent count, even with a large gap', () => {
    expect(resolveGradeErrorBadge(2.0, 4)).toBeNull();
    expect(resolveGradeErrorBadge(2.0, 0)).toBeNull();
    expect(resolveGradeErrorBadge(2.0, null)).toBeNull();
  });

  it('returns null for a missing or unparsable difficulty_error', () => {
    expect(resolveGradeErrorBadge(null, 100)).toBeNull();
    expect(resolveGradeErrorBadge(undefined, 100)).toBeNull();
    expect(resolveGradeErrorBadge('not-a-number', 100)).toBeNull();
  });

  it('treats the threshold and ascent-count boundaries as inclusive', () => {
    expect(resolveGradeErrorBadge(0.5, 5)).toEqual({ direction: 'stiff', amount: 0.5 });
  });
});
