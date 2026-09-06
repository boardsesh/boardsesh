// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// If HoldTarget ever reaches for RNGH again this records it, so a reinstated
// per-hold detector fails the suite instead of quietly competing with the
// board's full-bleed overlay (#4496).
const gestureUse = { count: 0 };

vi.mock('react-native', () => ({
  View: ({ children, pointerEvents }: { children?: ReactNode; pointerEvents?: string }) =>
    createElement('div', { 'data-pointer-events': pointerEvents }, children),
}));

vi.mock('react-native-gesture-handler', () => ({
  Gesture: {
    Tap: () => {
      gestureUse.count += 1;
      throw new Error('HoldTarget must stay a marker — see #4496');
    },
    LongPress: () => {
      gestureUse.count += 1;
      throw new Error('HoldTarget must stay a marker — see #4496');
    },
  },
  GestureDetector: ({ children }: { children?: ReactNode }) => {
    gestureUse.count += 1;
    return createElement('div', { 'data-gesture': 'true' }, children);
  },
}));

import { HoldTarget } from '../HoldTarget';

function renderHoldTarget() {
  gestureUse.count = 0;
  return render(<HoldTarget leftPct={10} topPct={20} dotDiameter={6} dotColor="#fff" />);
}

describe('HoldTarget', () => {
  it('renders an inert marker: no gesture detector, no hit-testing', () => {
    // Per-hold detectors used to own an inflated square each; overlapping
    // squares are arbitrated by z-order, so the last hold in the list won every
    // touch inside its square (#4496). Taps now belong to the board's single
    // full-bleed overlay, and this layer must never take one back.
    const { container } = renderHoldTarget();
    expect(container.querySelector('[data-gesture="true"]')).toBeNull();
    expect(gestureUse.count).toBe(0);
    expect(container.firstElementChild?.getAttribute('data-pointer-events')).toBe('none');
  });

  it('draws exactly one dot per hold, with no wrapper box around it', () => {
    // The old inflated tap square wrapped the dot; nothing needs it now.
    const { container } = renderHoldTarget();
    expect(container.querySelectorAll('div').length).toBe(1);
  });
});
