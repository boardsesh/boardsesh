import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ PanResponder: { create: () => ({ panHandlers: {} }) } }));

import { isSwipeUp } from '../use-swipe-up-to-open';

describe('isSwipeUp', () => {
  it('takes a deliberate upward swipe', () => {
    expect(isSwipeUp(0, -24)).toBe(true);
    expect(isSwipeUp(10, -60)).toBe(true);
  });

  it('leaves a short move alone, so taps and small slips still work', () => {
    expect(isSwipeUp(0, -23)).toBe(false);
  });

  it('leaves downward drags to the sheet', () => {
    expect(isSwipeUp(0, 60)).toBe(false);
  });

  it('leaves sideways and diagonal drags to the rails', () => {
    expect(isSwipeUp(80, -10)).toBe(false);
    expect(isSwipeUp(40, -40)).toBe(false);
  });
});
