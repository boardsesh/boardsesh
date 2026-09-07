// The rules the report sheet enforces before the backend gets a say. Three of
// them are wrong-by-one if written from memory and invisible in a render test:
//   - the 10..500 bound is on the TRIMMED reason, so whitespace can't pad it;
//   - a hide report carries no angle and no grade, a grade report carries both;
//   - the grade a report proposes is the RAW `Grade.name`, and proposing the one
//     the climb already has is refused here rather than by a server round trip.
import { describe, expect, it } from 'vitest';
import {
  REASON_MAX,
  REASON_MIN,
  buildReportInput,
  remainingReasonCharacters,
  reportToastCopy,
  validateReason,
} from '../report-climb-form';

const baseArgs = {
  climbUuid: 'climb-1',
  boardType: 'kilter',
  angle: 40,
  reason: 'This climb is a duplicate of another one',
};

const proposal = { weightedUpvotes: 2, requiredUpvotes: 5 };

describe('validateReason', () => {
  it('rejects a reason shorter than the minimum', () => {
    expect(validateReason('a'.repeat(REASON_MIN - 1))).toBe('tooShort');
  });

  it('accepts a reason exactly at the minimum', () => {
    expect(validateReason('a'.repeat(REASON_MIN))).toBeNull();
  });

  it('accepts a reason exactly at the maximum and rejects one character more', () => {
    expect(validateReason('a'.repeat(REASON_MAX))).toBeNull();
    expect(validateReason('a'.repeat(REASON_MAX + 1))).toBe('tooLong');
  });

  // Padding with spaces must not buy length: the backend trims too, so a reason
  // that only clears the floor with whitespace would be rejected server-side.
  it('measures the trimmed reason, so whitespace cannot pad it', () => {
    expect(validateReason(`   ${'a'.repeat(REASON_MIN - 1)}   `)).toBe('tooShort');
    expect(validateReason(`   ${'a'.repeat(REASON_MIN)}   `)).toBeNull();
  });

  it('counts down the characters still needed, then stops at zero', () => {
    expect(remainingReasonCharacters('short')).toBe(REASON_MIN - 'short'.length);
    expect(remainingReasonCharacters('  short  ')).toBe(REASON_MIN - 'short'.length);
    expect(remainingReasonCharacters('a'.repeat(REASON_MIN + 20))).toBe(0);
  });
});

describe('buildReportInput', () => {
  it('drops the angle and the grade on a hide report', () => {
    const result = buildReportInput({ ...baseArgs, kind: 'hide', selectedGradeName: '6b+/V4' });
    expect(result).toEqual({
      ok: true,
      input: {
        climbUuid: 'climb-1',
        boardType: 'kilter',
        angle: null,
        kind: 'hide',
        reason: 'This climb is a duplicate of another one',
      },
    });
  });

  it('carries the angle and the raw grade label on a grade report', () => {
    const result = buildReportInput({
      ...baseArgs,
      kind: 'grade',
      selectedGradeName: '6c/V5',
      currentGradeName: '6b+/V4',
    });
    expect(result).toEqual({
      ok: true,
      input: {
        climbUuid: 'climb-1',
        boardType: 'kilter',
        angle: 40,
        kind: 'grade',
        proposedGrade: '6c/V5',
        reason: 'This climb is a duplicate of another one',
      },
    });
  });

  it('trims the reason it sends', () => {
    const result = buildReportInput({ ...baseArgs, reason: `  ${baseArgs.reason}  `, kind: 'hide' });
    expect(result.ok && result.input.reason).toBe(baseArgs.reason);
  });

  it('refuses a reason that is too short, whichever kind', () => {
    expect(buildReportInput({ ...baseArgs, reason: 'nope', kind: 'hide' })).toEqual({ ok: false, error: 'reason' });
    const short = buildReportInput({ ...baseArgs, reason: 'nope', kind: 'grade', selectedGradeName: '6c/V5' });
    expect(short).toEqual({ ok: false, error: 'reason' });
  });

  it('refuses a grade report with no grade picked', () => {
    expect(buildReportInput({ ...baseArgs, kind: 'grade', selectedGradeName: null })).toEqual({
      ok: false,
      error: 'noGrade',
    });
  });

  it('refuses the grade the climb already has', () => {
    const sameGrade = buildReportInput({
      ...baseArgs,
      kind: 'grade',
      selectedGradeName: '6b+/V4',
      currentGradeName: '6b+/V4',
    });
    expect(sameGrade).toEqual({ ok: false, error: 'sameGrade' });
  });

  // A climb with no recorded grade can still take a grade report — there is
  // nothing to be the same as.
  it('allows any grade when the climb has no current grade', () => {
    const args = { ...baseArgs, kind: 'grade' as const, selectedGradeName: '6c/V5', currentGradeName: null };
    expect(buildReportInput(args).ok).toBe(true);
  });
});

describe('reportToastCopy', () => {
  it('reports the vote tally for a hide report, whether it opened or joined a proposal', () => {
    for (const status of ['created', 'added'] as const) {
      expect(reportToastCopy(status, 'hide', proposal)).toEqual({
        textI18nKey: 'mobile.report.toast.reported',
        params: { current: 2, required: 5 },
      });
    }
  });

  it('uses the grade copy for a grade report', () => {
    for (const status of ['created', 'added'] as const) {
      expect(reportToastCopy(status, 'grade', proposal)).toEqual({
        textI18nKey: 'mobile.report.toast.reportedGrade',
        params: {},
      });
    }
  });

  it('says nothing about votes when this climber already reported the climb', () => {
    expect(reportToastCopy('already_reported', 'hide', proposal)).toEqual({
      textI18nKey: 'mobile.report.toast.alreadyReported',
      params: {},
    });
    expect(reportToastCopy('already_reported', 'grade', proposal)).toEqual({
      textI18nKey: 'mobile.report.toast.alreadyReported',
      params: {},
    });
  });
});
