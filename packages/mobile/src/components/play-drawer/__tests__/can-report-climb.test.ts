import { describe, it, expect } from 'vitest';
import { canReportDisplayedClimb } from '../can-report-climb';

const base = { isAuthenticated: true, moderationEnabled: true, currentUserId: 'me' };

describe('canReportDisplayedClimb', () => {
  it("offers Report on somebody else's published climb", () => {
    expect(canReportDisplayedClimb({ ...base, climb: { is_draft: false, userId: 'other' } })).toBe(true);
  });
  it('hides Report on your own published climb', () => {
    expect(canReportDisplayedClimb({ ...base, climb: { is_draft: false, userId: 'me' } })).toBe(false);
  });
  it('hides Report on a draft', () => {
    expect(canReportDisplayedClimb({ ...base, climb: { is_draft: true, userId: 'other' } })).toBe(false);
  });
  it('hides Report when signed out, moderation is off, or there is no climb', () => {
    const climb = { is_draft: false, userId: 'other' };
    expect(canReportDisplayedClimb({ ...base, isAuthenticated: false, climb })).toBe(false);
    expect(canReportDisplayedClimb({ ...base, moderationEnabled: false, climb })).toBe(false);
    expect(canReportDisplayedClimb({ ...base, climb: null })).toBe(false);
  });
  it('still offers Report when the viewer id is unknown', () => {
    expect(canReportDisplayedClimb({ ...base, currentUserId: null, climb: { userId: 'other' } })).toBe(true);
  });
});
