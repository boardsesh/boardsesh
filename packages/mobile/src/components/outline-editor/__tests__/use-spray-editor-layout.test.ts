import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({
  Dimensions: { get: () => ({ width: 1024, height: 1366 }) },
  Platform: { OS: 'ios', isPad: true },
  useWindowDimensions: () => ({ width: 1024, height: 1366 }),
}));
import { resolveSprayEditorLayout, sprayPhotoReservesBottom } from '../use-spray-editor-layout';

describe('resolveSprayEditorLayout', () => {
  it('is the tablet layout for an iPad window at the regular width', () => {
    expect(
      resolveSprayEditorLayout({ isPad: true, widthClass: 'regular', windowWidth: 1366, windowHeight: 1024 }),
    ).toEqual({ layout: 'tablet', landscape: true });
    expect(
      resolveSprayEditorLayout({ isPad: true, widthClass: 'regular', windowWidth: 1024, windowHeight: 1366 }),
    ).toEqual({ layout: 'tablet', landscape: false });
  });

  // Split View, Slide Over and a small iPadOS 26 window all narrow below 700 pt.
  it('drops to the phone layout when an iPad window narrows', () => {
    expect(
      resolveSprayEditorLayout({ isPad: true, widthClass: 'compact', windowWidth: 507, windowHeight: 1024 }),
    ).toEqual({ layout: 'phone', landscape: false });
  });

  // The spray flows only cover the screen on iPad, so nothing else gets the
  // tablet layout, however wide its window.
  it('keeps phones and Android tablets on the phone layout', () => {
    expect(
      resolveSprayEditorLayout({ isPad: false, widthClass: 'compact', windowWidth: 393, windowHeight: 852 }).layout,
    ).toBe('phone');
    expect(
      resolveSprayEditorLayout({ isPad: false, widthClass: 'regular', windowWidth: 1280, windowHeight: 800 }).layout,
    ).toBe('phone');
  });

  it('reserves the bottom bar under the photo on the phone layout only', () => {
    expect(sprayPhotoReservesBottom('phone')).toBe(true);
    expect(sprayPhotoReservesBottom('tablet')).toBe(false);
  });
});
