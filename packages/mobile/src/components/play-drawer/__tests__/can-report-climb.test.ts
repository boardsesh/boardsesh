import { describe, expect, it } from 'vitest';
import { ownClimbIsReportable } from '../can-report-climb';

describe('ownClimbIsReportable', () => {
  it('lets a setter report their own climb only on a spray wall, where the report changes its grade', () => {
    expect(ownClimbIsReportable('spray')).toBe(true);
    expect(ownClimbIsReportable('kilter')).toBe(false);
    expect(ownClimbIsReportable(null)).toBe(false);
    expect(ownClimbIsReportable(undefined)).toBe(false);
  });
});
