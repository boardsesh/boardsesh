import { describe, expect, it } from 'vitest';
import { swapLabelFade, type SwapLabelFades } from '../wall-glow-swap-fade';

const fades: SwapLabelFades = { centerPage: 5, previous: 0.65, current: 0.2, next: 0.5 };

describe('swapLabelFade', () => {
  it('is the climb on show without frames, and at rest', () => {
    expect(swapLabelFade(null, fades)).toBe(0.2);
    expect(swapLabelFade([5, 1, 0, 1], fades)).toBe(0.2);
    expect(swapLabelFade([5.25, 1, 0, 1, 0, 0], fades)).toBe(0.2);
  });

  it('is the higher of the pair while the board shows both climbs', () => {
    expect(swapLabelFade([5.25, 0.6, 0.3, 1, 0, 1], fades)).toBe(0.5);
    expect(swapLabelFade([4.75, 0.6, 0.3, 1, 0, 2], fades)).toBe(0.65);
    // A swap that ended on the next page before the app caught up: that climb's fade.
    expect(swapLabelFade([6, 1, 0, 1, 0, 0], fades)).toBe(0.5);
  });

  it('takes no fade from a side with nothing to draw, and the strongest for a page it does not know', () => {
    expect(swapLabelFade([5.25, 0.6, 0.3, 1], { ...fades, next: null })).toBe(0.2);
    expect(swapLabelFade([7, 1, 0, 1], fades)).toBe(0.65);
  });
});
