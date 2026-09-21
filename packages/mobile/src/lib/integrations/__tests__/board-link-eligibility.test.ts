import { describe, it, expect } from 'vitest';
import { hasNoLinkedBoardAccount, isLinkableBoard } from '../board-link-eligibility';

describe('isLinkableBoard', () => {
  it('accepts the Aurora-backed boards, which have a credential flow', () => {
    for (const boardType of ['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill']) {
      expect(isLinkableBoard(boardType)).toBe(true);
    }
  });

  // Connected apps offers MoonBoard file import, not a credential-linking form.
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

  // Unknown credentials do not establish that the climber has no linked account.
  it('is undefined — not true — while the read is unresolved', () => {
    expect(hasNoLinkedBoardAccount(undefined)).toBeUndefined();
  });
});
