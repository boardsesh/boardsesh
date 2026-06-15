import { describe, it, expect } from 'vitest';
import { resolveDeviceLayout, REGULAR_WIDTH_BREAKPOINT, EXPANDED_WIDTH_BREAKPOINT } from '../size-class';

describe('resolveDeviceLayout', () => {
  it('keeps every iPhone compact regardless of width', () => {
    // An iPhone is never an iPad, so even a wide landscape phone stays compact
    // (renders the phone UI verbatim).
    expect(resolveDeviceLayout({ width: 932, isPad: false })).toEqual({ widthClass: 'compact', expanded: false });
    expect(resolveDeviceLayout({ width: 430, isPad: false })).toEqual({ widthClass: 'compact', expanded: false });
  });

  it('keeps an iPad compact in a narrow split (Slide Over / ⅓ / ½)', () => {
    // 12.9" iPad split widths: Slide Over ~320, ½ ~507, ⅔ ~664 — all below 700.
    for (const width of [320, 375, 507, 664, REGULAR_WIDTH_BREAKPOINT - 1]) {
      expect(resolveDeviceLayout({ width, isPad: true })).toEqual({ widthClass: 'compact', expanded: false });
    }
  });

  it('is regular but not expanded for a narrow-regular iPad window', () => {
    // 11" iPad portrait (834) and a ⅔ split that clears 700 but not 1024.
    expect(resolveDeviceLayout({ width: 834, isPad: true })).toEqual({ widthClass: 'regular', expanded: false });
    expect(resolveDeviceLayout({ width: REGULAR_WIDTH_BREAKPOINT, isPad: true })).toEqual({
      widthClass: 'regular',
      expanded: false,
    });
    expect(resolveDeviceLayout({ width: EXPANDED_WIDTH_BREAKPOINT - 1, isPad: true })).toEqual({
      widthClass: 'regular',
      expanded: false,
    });
  });

  it('is expanded for a full-screen iPad (portrait 1024+ and any landscape)', () => {
    for (const width of [EXPANDED_WIDTH_BREAKPOINT, 1194, 1366]) {
      expect(resolveDeviceLayout({ width, isPad: true })).toEqual({ widthClass: 'regular', expanded: true });
    }
  });
});
