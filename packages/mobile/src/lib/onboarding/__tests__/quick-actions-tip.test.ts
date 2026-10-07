import { describe, expect, it } from 'vitest';
import { shouldShowQuickActionsTip } from '../quick-actions-tip';

const ready = { armed: true, revealTipShowing: false, connectCardVisible: false, climbCount: 3 };

describe('shouldShowQuickActionsTip', () => {
  it('shows once armed with climbs in the list and nothing else on screen', () => {
    expect(shouldShowQuickActionsTip(ready)).toBe(true);
  });

  // #5960: the tip teaches a gesture on a climb row, so an empty wall must not
  // spend it.
  it('waits while the list has no climbs', () => {
    expect(shouldShowQuickActionsTip({ ...ready, climbCount: 0 })).toBe(false);
  });

  it('yields to the board-reveal tip and the first-connect card', () => {
    expect(shouldShowQuickActionsTip({ ...ready, revealTipShowing: true })).toBe(false);
    expect(shouldShowQuickActionsTip({ ...ready, connectCardVisible: true })).toBe(false);
  });

  it('stays hidden once seen', () => {
    expect(shouldShowQuickActionsTip({ ...ready, armed: false })).toBe(false);
  });
});
