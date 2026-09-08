import { describe, it, expect } from 'vitest';
import { deriveLogbookGradeDisplay, resolveCrowdDifficulty, surfacedBoardseshGrade } from '../grade-display';

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

describe('surfacedBoardseshGrade', () => {
  it('prefers the cross-board universal grade when both are present', () => {
    expect(surfacedBoardseshGrade({ universalGrade: 22, localGrade: 20 })).toBe(22);
  });

  it('falls back to the board-local grade when there is no universal grade (small boards)', () => {
    // Decoy, Grasshopper, So iLL, and Touchstone never earn a cross-board
    // anchor (docs/boardsesh-grade.md §3), so universalGrade stays null and
    // localGrade is the only number a client can surface.
    expect(surfacedBoardseshGrade({ universalGrade: null, localGrade: 20 })).toBe(20);
    expect(surfacedBoardseshGrade({ universalGrade: undefined, localGrade: 20 })).toBe(20);
  });

  it('returns null when neither grade is available', () => {
    expect(surfacedBoardseshGrade({ universalGrade: null, localGrade: null })).toBeNull();
    expect(surfacedBoardseshGrade({})).toBeNull();
  });

  it('treats a zero grade as present (not falsy-skipped)', () => {
    expect(surfacedBoardseshGrade({ universalGrade: 0, localGrade: 20 })).toBe(0);
    expect(surfacedBoardseshGrade({ universalGrade: null, localGrade: 0 })).toBe(0);
  });

  it('pins the #4414 fixture: universal wins even though it is the softer/lower id', () => {
    // The exact row that used to render differently on web (local-first: 22,
    // rounds to 7a/V6) vs mobile (universal-first: 21, rounds to 6c+/V5). The
    // correct, single-source-of-truth answer is the universal one — see
    // "Which grade a client surfaces" in docs/boardsesh-grade.md.
    expect(surfacedBoardseshGrade({ localGrade: 22.03, universalGrade: 21.03 })).toBeCloseTo(21.03);
  });
});
