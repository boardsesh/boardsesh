import { describe, expect, it } from 'vitest';
import { canEditSessionDetail, isDailySessionId } from '../session-edit-permissions';

describe('canEditSessionDetail', () => {
  it('refuses a daily group even though it reports the viewer as owner', () => {
    expect(canEditSessionDetail({ sessionType: 'daily_highlight', ownerUserId: 'u1' }, 'u1')).toBe(false);
  });
  it('allows the owner of a party session', () => {
    expect(canEditSessionDetail({ sessionType: 'party', ownerUserId: 'u1' }, 'u1')).toBe(true);
  });
  it('refuses a party session owned by someone else or with missing data', () => {
    expect(canEditSessionDetail({ sessionType: 'party', ownerUserId: 'u2' }, 'u1')).toBe(false);
    expect(canEditSessionDetail({ sessionType: 'party', ownerUserId: 'u1' }, null)).toBe(false);
    expect(canEditSessionDetail(null, 'u1')).toBe(false);
  });
});

describe('isDailySessionId', () => {
  it('spots synthetic daily ids only', () => {
    expect(isDailySessionId('daily:u1:2026-09-06')).toBe(true);
    expect(isDailySessionId('0b0f6c1e-1111-2222-3333-444455556666')).toBe(false);
    expect(isDailySessionId(undefined)).toBe(false);
  });
});
