import { describe, it, expect } from 'vite-plus/test';
import { ReportClimbInputSchema, BrowseProposalsInputSchema, ProposalTypeSchema } from '../validation/schemas';

const CLIMB_UUID = 'report-climb-validation-climb';
const REASON = 'The middle crimp snapped off and the climb is unsendable now.';

const hideInput = (overrides: Record<string, unknown> = {}) => ({
  climbUuid: CLIMB_UUID,
  boardType: 'kilter',
  kind: 'hide',
  reason: REASON,
  ...overrides,
});

const gradeInput = (overrides: Record<string, unknown> = {}) => ({
  climbUuid: CLIMB_UUID,
  boardType: 'kilter',
  angle: 40,
  kind: 'grade',
  proposedGrade: '6c/V5',
  reason: REASON,
  ...overrides,
});

describe('ProposalTypeSchema', () => {
  it('accepts the hide type', () => {
    expect(ProposalTypeSchema.safeParse('hide').success).toBe(true);
  });

  it('still rejects an unknown type', () => {
    expect(ProposalTypeSchema.safeParse('unlist').success).toBe(false);
  });
});

describe('ReportClimbInputSchema', () => {
  it('accepts a hide report with no angle', () => {
    const result = ReportClimbInputSchema.safeParse(hideInput());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.angle).toBeNull();
    }
  });

  it('drops the angle and grade a hide report carries along', () => {
    const result = ReportClimbInputSchema.safeParse(hideInput({ angle: 40, proposedGrade: '6c/V5' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.angle).toBeNull();
      expect(result.data.proposedGrade).toBeNull();
    }
  });

  it('accepts a grade report with an angle and a known grade label', () => {
    const result = ReportClimbInputSchema.safeParse(gradeInput());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.angle).toBe(40);
      expect(result.data.proposedGrade).toBe('6c/V5');
    }
  });

  it('rejects a grade report with no angle', () => {
    const result = ReportClimbInputSchema.safeParse(gradeInput({ angle: null }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['angle']);
      expect(result.error.issues[0].message).toBe('Angle is required for grade reports');
    }
  });

  it('rejects a grade report with no proposed grade', () => {
    const result = ReportClimbInputSchema.safeParse(gradeInput({ proposedGrade: null }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.message === 'A proposed grade is required for grade reports'),
      ).toBe(true);
    }
  });

  it('rejects a grade label that is not in the grade table', () => {
    const result = ReportClimbInputSchema.safeParse(gradeInput({ proposedGrade: 'V17' }));
    expect(result.success).toBe(false);
  });

  it('rejects a negative angle the board does not support', () => {
    const result = ReportClimbInputSchema.safeParse(gradeInput({ angle: -5 }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'angle')).toBe(true);
    }
  });

  it('rejects a reason under ten characters, whitespace not counted', () => {
    expect(ReportClimbInputSchema.safeParse(hideInput({ reason: 'too short' })).success).toBe(false);
    expect(ReportClimbInputSchema.safeParse(hideInput({ reason: '   broken    ' })).success).toBe(false);
  });

  it('rejects a reason over 500 characters', () => {
    expect(ReportClimbInputSchema.safeParse(hideInput({ reason: 'x'.repeat(501) })).success).toBe(false);
  });

  it('trims the stored reason', () => {
    const result = ReportClimbInputSchema.safeParse(hideInput({ reason: `  ${REASON}  ` }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe(REASON);
    }
  });

  it('rejects an unknown report kind', () => {
    expect(ReportClimbInputSchema.safeParse(hideInput({ kind: 'delete' })).success).toBe(false);
  });

  it('rejects an unsupported board', () => {
    expect(ReportClimbInputSchema.safeParse(hideInput({ boardType: 'grasshopper-9000' })).success).toBe(false);
  });

  it('rejects an empty climb uuid', () => {
    expect(ReportClimbInputSchema.safeParse(hideInput({ climbUuid: '' })).success).toBe(false);
  });
});

describe('BrowseProposalsInputSchema', () => {
  it('accepts a multi-type filter', () => {
    const result = BrowseProposalsInputSchema.safeParse({ types: ['hide', 'grade'] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.types).toEqual(['hide', 'grade']);
    }
  });

  it('accepts the filter being omitted', () => {
    const result = BrowseProposalsInputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.types).toBeUndefined();
    }
  });

  it('rejects more entries than there are proposal types', () => {
    const result = BrowseProposalsInputSchema.safeParse({
      types: ['hide', 'grade', 'classic', 'benchmark', 'hide'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown type in the list', () => {
    expect(BrowseProposalsInputSchema.safeParse({ types: ['hide', 'unlist'] }).success).toBe(false);
  });
});
