import { describe, it, expect } from 'vitest';
import {
  renderDifficulty,
  clampDifficultyId,
  resolveBoardseshDifficulty,
  resolveBoardseshDifficultyId,
  resolveDisplayGrade,
  resolveCrowdDifficultyId,
  resolveTickDefaultGradeName,
  MIN_DIFFICULTY_ID,
  MAX_DIFFICULTY_ID,
} from '../boardsesh-grade-display';

describe('renderDifficulty / clampDifficultyId', () => {
  it('rounds a float to the nearest grade and colours it', () => {
    // 20 = 6c/V5 on the shared scale.
    const rendered = renderDifficulty(20.3, 'v-grade');
    expect(rendered?.label).toBe('V5');
    expect(rendered?.color).toMatch(/^#/);
  });

  it('clamps below and above the scale bounds', () => {
    expect(clampDifficultyId(-100)).toBe(MIN_DIFFICULTY_ID);
    expect(clampDifficultyId(9999)).toBe(MAX_DIFFICULTY_ID);
  });
});

describe('resolveBoardseshDifficulty', () => {
  it('returns null when boardseshDifficulty is null or undefined', () => {
    expect(resolveBoardseshDifficulty({ boardseshDifficulty: null })).toBeNull();
    expect(resolveBoardseshDifficulty({ boardseshDifficulty: undefined })).toBeNull();
    expect(resolveBoardseshDifficulty({})).toBeNull();
  });

  it('returns null for setter_only confidence even with a value present', () => {
    expect(resolveBoardseshDifficulty({ boardseshDifficulty: 20.3, boardseshConfidence: 'setter_only' })).toBeNull();
  });

  it('returns the raw value for confirmed/provisional/unknown confidence', () => {
    expect(resolveBoardseshDifficulty({ boardseshDifficulty: 20.3, boardseshConfidence: 'confirmed' })).toBe(20.3);
    expect(resolveBoardseshDifficulty({ boardseshDifficulty: 20.3, boardseshConfidence: 'provisional' })).toBe(20.3);
    expect(resolveBoardseshDifficulty({ boardseshDifficulty: 20.3, boardseshConfidence: undefined })).toBe(20.3);
  });

  it('treats a zero difficulty as present (not falsy-skipped)', () => {
    expect(resolveBoardseshDifficulty({ boardseshDifficulty: 0, boardseshConfidence: 'confirmed' })).toBe(0);
  });
});

describe('resolveBoardseshDifficultyId', () => {
  it('rounds and clamps the resolved difficulty', () => {
    expect(resolveBoardseshDifficultyId({ boardseshDifficulty: 20.6, boardseshConfidence: 'confirmed' })).toBe(21);
    expect(resolveBoardseshDifficultyId({ boardseshDifficulty: -100, boardseshConfidence: 'confirmed' })).toBe(
      MIN_DIFFICULTY_ID,
    );
    expect(resolveBoardseshDifficultyId({ boardseshDifficulty: 9999, boardseshConfidence: 'confirmed' })).toBe(
      MAX_DIFFICULTY_ID,
    );
  });

  it('returns null when the underlying value resolves to null', () => {
    expect(resolveBoardseshDifficultyId({ boardseshDifficulty: null })).toBeNull();
    expect(resolveBoardseshDifficultyId({ boardseshDifficulty: 20, boardseshConfidence: 'setter_only' })).toBeNull();
  });
});

describe('resolveDisplayGrade', () => {
  const legacyClimb = { difficulty: '6b/V4', boardseshDifficulty: 20, boardseshConfidence: 'confirmed' as const };

  it('renders the legacy grade when the toggle is off', () => {
    const display = resolveDisplayGrade(legacyClimb, { useBoardseshGrades: false, gradeFormat: 'v-grade' });
    expect(display).toEqual({
      label: 'V4',
      color: expect.stringMatching(/^#/),
      isBoardsesh: false,
      isEstimated: false,
    });
  });

  it('renders the legacy grade when boardseshDifficulty is null, even with the toggle on', () => {
    const display = resolveDisplayGrade(
      { difficulty: '6b/V4', boardseshDifficulty: null, boardseshConfidence: null },
      { useBoardseshGrades: true, gradeFormat: 'v-grade' },
    );
    expect(display).toEqual({
      label: 'V4',
      color: expect.stringMatching(/^#/),
      isBoardsesh: false,
      isEstimated: false,
    });
  });

  it('renders the legacy grade for setter_only confidence, even with the toggle on', () => {
    const display = resolveDisplayGrade(
      { difficulty: '6b/V4', boardseshDifficulty: 27, boardseshConfidence: 'setter_only' },
      { useBoardseshGrades: true, gradeFormat: 'v-grade' },
    );
    expect(display).toEqual({
      label: 'V4',
      color: expect.stringMatching(/^#/),
      isBoardsesh: false,
      isEstimated: false,
    });
  });

  it('prefers the Boardsesh grade when the toggle is on and it is trusted', () => {
    // 20 = 6c/V5, differs from the legacy 6b/V4 so the swap is observable.
    const display = resolveDisplayGrade(legacyClimb, { useBoardseshGrades: true, gradeFormat: 'v-grade' });
    expect(display).toEqual({ label: 'V5', color: expect.stringMatching(/^#/), isBoardsesh: true, isEstimated: false });
  });

  it('formats the Boardsesh grade per the v-grade/font/both preference', () => {
    // 20 = 6c/V5.
    expect(resolveDisplayGrade(legacyClimb, { useBoardseshGrades: true, gradeFormat: 'v-grade' }).label).toBe('V5');
    expect(resolveDisplayGrade(legacyClimb, { useBoardseshGrades: true, gradeFormat: 'font' }).label).toBe('6C');
    expect(resolveDisplayGrade(legacyClimb, { useBoardseshGrades: true, gradeFormat: 'both' }).label).toBe('V5 / 6C');
  });

  it('rounds and clamps the Boardsesh difficulty before rendering', () => {
    const display = resolveDisplayGrade(
      { difficulty: '6b/V4', boardseshDifficulty: 9999, boardseshConfidence: 'confirmed' },
      { useBoardseshGrades: true, gradeFormat: 'v-grade' },
    );
    expect(display.label).toBe('V16'); // clamps to 8c+/V16
    expect(display.isBoardsesh).toBe(true);
  });

  it('falls back to an empty label when the legacy difficulty is missing entirely', () => {
    const display = resolveDisplayGrade({}, { useBoardseshGrades: false, gradeFormat: 'v-grade' });
    expect(display).toEqual({ label: '', color: expect.stringMatching(/^#/), isBoardsesh: false, isEstimated: false });
  });

  it('marks a cross-angle estimate with the ≈ prefix and isEstimated', () => {
    const display = resolveDisplayGrade(
      { difficulty: '6b/V4', boardseshDifficulty: 20, boardseshConfidence: 'cross_angle_estimate' },
      { useBoardseshGrades: true, gradeFormat: 'v-grade' },
    );
    expect(display.label).toBe('≈V5');
    expect(display.isBoardsesh).toBe(true);
    expect(display.isEstimated).toBe(true);
  });
});

describe('resolveCrowdDifficultyId', () => {
  it('returns the legacy consensus when the toggle is off, ignoring the Boardsesh grade', () => {
    expect(
      resolveCrowdDifficultyId(
        { boardseshDifficulty: 18.4, boardseshConfidence: 'confirmed', consensusDifficulty: 15 },
        false,
      ),
    ).toBe(15);
  });

  it('returns the rounded Boardsesh grade when the toggle is on and it is trusted', () => {
    expect(
      resolveCrowdDifficultyId(
        { boardseshDifficulty: 18.4, boardseshConfidence: 'confirmed', consensusDifficulty: 15 },
        true,
      ),
    ).toBe(18);
  });

  it('falls back to the consensus for a setter_only Boardsesh grade even with the toggle on', () => {
    expect(
      resolveCrowdDifficultyId(
        { boardseshDifficulty: 18.4, boardseshConfidence: 'setter_only', consensusDifficulty: 15 },
        true,
      ),
    ).toBe(15);
  });

  it('returns null when neither a trusted Boardsesh grade nor a consensus is available', () => {
    expect(resolveCrowdDifficultyId({ boardseshDifficulty: null, consensusDifficulty: null }, true)).toBeNull();
  });

  // A user's own logged ascent grade is never an input here — it always wins
  // upstream of this resolver, which only ever sees the crowd-sourced side.
});

describe('resolveTickDefaultGradeName', () => {
  it('returns null when the toggle is off', () => {
    expect(
      resolveTickDefaultGradeName({ boardseshDifficulty: 20, boardseshConfidence: 'confirmed' }, false),
    ).toBeNull();
  });

  it('returns null when there is no trusted Boardsesh grade', () => {
    expect(resolveTickDefaultGradeName({ boardseshDifficulty: null }, true)).toBeNull();
    expect(
      resolveTickDefaultGradeName({ boardseshDifficulty: 20, boardseshConfidence: 'setter_only' }, true),
    ).toBeNull();
  });

  it('never seeds the picker from a cross_angle_estimate, even with a real difficulty value', () => {
    // Pre-filling a projection would feed the model's own output back into the
    // ascent grades it's estimated from — the echo loop the model corrects for.
    expect(
      resolveTickDefaultGradeName({ boardseshDifficulty: 20, boardseshConfidence: 'cross_angle_estimate' }, true),
    ).toBeNull();
  });

  it('returns the Aurora difficulty_name for the resolved Boardsesh grade id', () => {
    // 20 = 6c/V5.
    expect(resolveTickDefaultGradeName({ boardseshDifficulty: 20.3, boardseshConfidence: 'confirmed' }, true)).toBe(
      '6c/V5',
    );
  });

  it('rounds and clamps before resolving the name', () => {
    expect(resolveTickDefaultGradeName({ boardseshDifficulty: 9999, boardseshConfidence: 'confirmed' }, true)).toBe(
      '8c+/V16',
    );
  });
});
