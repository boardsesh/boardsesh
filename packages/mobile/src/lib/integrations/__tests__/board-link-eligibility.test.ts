import { describe, it, expect } from 'vitest';
import { hasNoLinkedBoardAccount, isLinkableBoard } from '../board-link-eligibility';

describe('isLinkableBoard', () => {
  it('accepts the Aurora-backed boards, which have a credential flow', () => {
    for (const boardType of ['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill']) {
      expect(isLinkableBoard(boardType)).toBe(true);
    }
  });

  // MoonBoard's only route in is a CSV the climber obtains by emailing Moon
  // Climbing a GDPR subject access request. Offering them a "link your account"
  // button would be a promise we cannot keep.
  it('rejects MoonBoard, which has no credential flow at all', () => {
    expect(isLinkableBoard('moonboard')).toBe(false);
  });

  it('rejects an unbound board', () => {
    expect(isLinkableBoard(undefined)).toBe(false);
  });
});

describe('hasNoLinkedBoardAccount', () => {
  it('is true only when the read resolved and came back empty', () => {
    expect(hasNoLinkedBoardAccount([])).toBe(true);
  });

  it('is false when any account is linked', () => {
    expect(hasNoLinkedBoardAccount([{ boardType: 'tension' }])).toBe(false);
  });

  // The load-bearing case. The credentials query is `offlineFirst`, so offline it
  // stays pending forever and `data` stays undefined. Collapsing that to `true`
  // would tell a climber who linked months ago that they never linked.
  it('is undefined — not true — while the read is unresolved', () => {
    expect(hasNoLinkedBoardAccount(undefined)).toBeUndefined();
  });
});
