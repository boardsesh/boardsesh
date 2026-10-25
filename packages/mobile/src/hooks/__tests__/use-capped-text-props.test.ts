// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const device = vi.hoisted(() => ({ fontScale: 2 }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  useWindowDimensions: () => ({ fontScale: device.fontScale }),
}));
// Material caption1 (labelSmall): 11sp on a 16sp line.
const theme = vi.hoisted(() => ({
  textStyles: { caption1: { fontSize: 11, fontWeight: '500' as const, lineHeight: 16 } },
}));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => theme }));

import { cappedTextProps, useCappedTextProps } from '../use-capped-text-props';

const CAPTION = theme.textStyles.caption1;

describe('cappedTextProps', () => {
  it('leaves iOS to maxFontSizeMultiplier, which caps the line height too', () => {
    expect(cappedTextProps({ platform: 'ios', fontScale: 2, typeStyle: CAPTION, cap: 1.2 })).toEqual({
      maxFontSizeMultiplier: 1.2,
    });
  });

  // Android scaled the line height by the full 2.0 while the font stopped at
  // 1.2, so the top bar's two lines ran into the grabber.
  it('scales the font and the line height together on Android, stopping at the cap', () => {
    expect(cappedTextProps({ platform: 'android', fontScale: 2, typeStyle: CAPTION, cap: 1.2 })).toEqual({
      allowFontScaling: false,
      style: { fontSize: 11 * 1.2, lineHeight: 16 * 1.2 },
    });
  });

  it('follows a smaller Android text size below the cap', () => {
    expect(cappedTextProps({ platform: 'android', fontScale: 0.85, typeStyle: CAPTION, cap: 1.2 }).style).toEqual({
      fontSize: 11 * 0.85,
      lineHeight: 16 * 0.85,
    });
  });

  it('leaves out what the variant does not set', () => {
    expect(cappedTextProps({ platform: 'android', fontScale: 1, typeStyle: { fontSize: 13 }, cap: 1.2 }).style).toEqual(
      { fontSize: 13 },
    );
  });
});

describe('useCappedTextProps', () => {
  it("reads the theme's variant and the system text size", () => {
    device.fontScale = 2;
    const { result } = renderHook(() => useCappedTextProps('caption1', 1.2));
    expect(result.current).toEqual({ allowFontScaling: false, style: { fontSize: 11 * 1.2, lineHeight: 16 * 1.2 } });
  });

  // A new object every render would hand each Text a new style and defeat memo.
  it('keeps the same props until the text size changes', () => {
    device.fontScale = 2;
    const { result, rerender } = renderHook(() => useCappedTextProps('caption1', 1.2));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    device.fontScale = 1;
    rerender();
    expect(result.current).not.toBe(first);
    expect(result.current.style).toEqual({ fontSize: 11, lineHeight: 16 });
  });
});
