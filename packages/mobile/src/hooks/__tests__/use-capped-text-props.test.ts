import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, useWindowDimensions: () => ({ fontScale: 1 }) }));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ textStyles: {} }) }));

import { cappedTextProps } from '../use-capped-text-props';

// Material caption1 (labelSmall): 11sp on a 16sp line.
const CAPTION = { fontSize: 11, fontWeight: '500', lineHeight: 16 } as const;

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
