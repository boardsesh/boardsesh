import { describe, it, expect } from 'vitest';
import { queueSnackbarBottomOffset } from '../queue-snackbar-position';

// Representative metrics: tab bar 49, queue bar 56, gap 8, bottom inset 34.
const BASE = { insetsBottom: 34, tabBarHeight: 49, barContentHeight: 56, gap: 8 };

describe('queueSnackbarBottomOffset', () => {
  it('floats one gap above the tab bar when the queue bar is hidden', () => {
    // 34 + 49 + 0 + 8
    expect(queueSnackbarBottomOffset({ ...BASE, barVisible: false })).toBe(91);
  });

  it('clears the queue bar (bar height + gap) when it is visible', () => {
    // 34 + 49 + (56 + 8) + 8
    expect(queueSnackbarBottomOffset({ ...BASE, barVisible: true })).toBe(155);
  });

  it('the bar-visible offset is exactly barContentHeight + gap higher than hidden', () => {
    const hidden = queueSnackbarBottomOffset({ ...BASE, barVisible: false });
    const shown = queueSnackbarBottomOffset({ ...BASE, barVisible: true });
    expect(shown - hidden).toBe(BASE.barContentHeight + BASE.gap);
  });

  it('handles a zero safe-area inset', () => {
    expect(queueSnackbarBottomOffset({ ...BASE, insetsBottom: 0, barVisible: false })).toBe(57);
  });
});
