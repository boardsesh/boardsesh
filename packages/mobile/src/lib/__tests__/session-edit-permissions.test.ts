import { describe, expect, it } from 'vitest';
import { canEditSessionDetail } from '../session-edit-permissions';

describe('canEditSessionDetail', () => {
  it('allows the owner of a real (party) session to edit it', () => {
    expect(canEditSessionDetail({ sessionType: 'party', ownerUserId: 'user-1' }, 'user-1')).toBe(true);
  });

  it('denies a non-owner of a real session', () => {
    expect(canEditSessionDetail({ sessionType: 'party', ownerUserId: 'user-1' }, 'user-2')).toBe(false);
  });

  // The regression this guards: a daily_highlight always reports the viewer as
  // its own owner (SessionDetail.ownerUserId === the day's climber), so an
  // ownership-only gate rendered the pencil — and every save then failed with
  // "Invalid input: Session ID must be alphanumeric with hyphens only" because
  // the synthetic `daily:<user>:<date>` id has no board_sessions row to update
  // (issue #5290).
  it('denies editing a daily-highlight session even when the viewer "owns" it', () => {
    expect(canEditSessionDetail({ sessionType: 'daily_highlight', ownerUserId: 'user-1' }, 'user-1')).toBe(false);
  });

  it('denies when the session has no owner', () => {
    expect(canEditSessionDetail({ sessionType: 'party', ownerUserId: null }, 'user-1')).toBe(false);
  });

  it('denies an unauthenticated viewer', () => {
    expect(canEditSessionDetail({ sessionType: 'party', ownerUserId: 'user-1' }, null)).toBe(false);
  });

  it('denies while the session has not loaded yet', () => {
    expect(canEditSessionDetail(null, 'user-1')).toBe(false);
    expect(canEditSessionDetail(undefined, 'user-1')).toBe(false);
  });
});
