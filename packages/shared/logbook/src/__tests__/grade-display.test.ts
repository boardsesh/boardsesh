import { describe, it, expect } from 'vitest';
import { resolveCrowdDifficulty } from '../grade-display';

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
