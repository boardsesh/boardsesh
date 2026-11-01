import { describe, expect, it } from 'vitest';
import { NO_HORIZONTAL_SAFE_AREA, resolveHorizontalSafeArea } from '../horizontal-safe-area';

describe('resolveHorizontalSafeArea', () => {
  it('is a no-op on a portrait iPhone or an iPad tab, which have no side insets', () => {
    expect(resolveHorizontalSafeArea({ insets: { left: 0, right: 0 }, appliedByAncestor: false })).toBe(
      NO_HORIZONTAL_SAFE_AREA,
    );
  });

  it("pads clear of iPhone Duo's side tab rail", () => {
    // INFERRED from a simulator log: a tab on the Duo's inner display in landscape.
    expect(resolveHorizontalSafeArea({ insets: { left: 0, right: 84 }, appliedByAncestor: false })).toEqual({
      left: 0,
      right: 84,
    });
  });

  it('keeps both sides when both are inset', () => {
    expect(resolveHorizontalSafeArea({ insets: { left: 59, right: 59 }, appliedByAncestor: false })).toEqual({
      left: 59,
      right: 59,
    });
  });

  it('pads once: a container inside an inset container gets nothing', () => {
    expect(resolveHorizontalSafeArea({ insets: { left: 0, right: 84 }, appliedByAncestor: true })).toBe(
      NO_HORIZONTAL_SAFE_AREA,
    );
  });

  it('never pads by a negative inset', () => {
    expect(resolveHorizontalSafeArea({ insets: { left: -1, right: 84 }, appliedByAncestor: false })).toEqual({
      left: 0,
      right: 84,
    });
  });
});
