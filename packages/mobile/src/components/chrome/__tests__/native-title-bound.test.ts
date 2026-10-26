import { describe, it, expect, vi } from 'vitest';

// The spacing tokens pull the theme's colours, which import react-native.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: { ios?: unknown; default?: unknown }) => options.ios ?? options.default },
  DynamicColorIOS: (colors: { light: string }) => colors.light,
  PlatformColor: (name: string) => name,
}));
import {
  CENTER_CONTENT_MIN_WIDTH,
  nativeBarSideWidth,
  nativeItemsTitleMaxWidth,
  nativeTrailingItemLeft,
} from '../native-title-bound';

const NO_INSETS = { left: 0, right: 0 };
// Climbs in a horizontal bar: the glass avatar and + leading.
const GLASS_AVATAR_AND_CREATE = { customSlots: 2 };
const HISTORY_AND_MENU = { nativeItems: 2 };
const ANGLE_HISTORY_AND_MENU = { nativeItems: 3, titleItems: 1 };

describe('nativeBarSideWidth', () => {
  it('matches the widths measured on an iPhone 17 Pro', () => {
    expect(nativeBarSideWidth({})).toBe(0);
    expect(nativeBarSideWidth({ nativeItems: 1 })).toBe(44);
    // History and ⋯ sharing one glass.
    expect(nativeBarSideWidth(HISTORY_AND_MENU)).toBe(101);
    expect(nativeBarSideWidth(ANGLE_HISTORY_AND_MENU)).toBe(170);
    // The glass island: two 38pt slots inside UIKit's padding.
    expect(nativeBarSideWidth(GLASS_AVATAR_AND_CREATE)).toBe(84);
  });
});

describe('nativeItemsTitleMaxWidth', () => {
  it.each([
    [375, 134, 65],
    [402, 161, 92],
    [440, 199, 130],
  ])('gives the Climbs capsule on a %ipt iPhone %ipt, or %ipt beside an angle', (frameWidth, plain, withAngle) => {
    expect(
      nativeItemsTitleMaxWidth(frameWidth, NO_INSETS, { leading: GLASS_AVATAR_AND_CREATE, trailing: HISTORY_AND_MENU }),
    ).toBe(plain);
    expect(
      nativeItemsTitleMaxWidth(frameWidth, NO_INSETS, {
        leading: GLASS_AVATAR_AND_CREATE,
        trailing: ANGLE_HISTORY_AND_MENU,
      }),
    ).toBe(withAngle);
  });

  it.each([375, 402, 440])('ends a centred %ipt capsule before the trailing group', (frameWidth) => {
    const sides = { leading: GLASS_AVATAR_AND_CREATE, trailing: HISTORY_AND_MENU };
    const width = nativeItemsTitleMaxWidth(frameWidth, NO_INSETS, sides);
    const trailingLeft = frameWidth - 16 - nativeBarSideWidth(sides.trailing);
    expect(frameWidth / 2 + width / 2).toBeLessThanOrEqual(trailingLeft);
  });

  it('puts an angle under the minimum on 375pt and 402pt only, which is when the chrome moves it', () => {
    const roomBesideAngle = (frameWidth: number) =>
      nativeItemsTitleMaxWidth(frameWidth, NO_INSETS, {
        leading: GLASS_AVATAR_AND_CREATE,
        trailing: ANGLE_HISTORY_AND_MENU,
      });
    expect(roomBesideAngle(375)).toBeLessThan(CENTER_CONTENT_MIN_WIDTH);
    expect(roomBesideAngle(402)).toBeLessThan(CENTER_CONTENT_MIN_WIDTH);
    expect(roomBesideAngle(440)).toBeGreaterThanOrEqual(CENTER_CONTENT_MIN_WIDTH);
  });

  it('never goes below zero', () => {
    expect(
      nativeItemsTitleMaxWidth(320, NO_INSETS, { leading: { customSlots: 3 }, trailing: { nativeItems: 5 } }),
    ).toBe(0);
  });
});

describe('nativeTrailingItemLeft', () => {
  it('finds history, second from the end, where the iPhone 17 Pro shot has it', () => {
    // Measured: the history glyph centres at x307 on the 402pt screen.
    expect(nativeTrailingItemLeft(402, 0, 1) + 22).toBe(307);
  });
});
