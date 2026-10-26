import { describe, it, expect, vi } from 'vitest';

// The spacing tokens pull the theme's colours, which import react-native.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: { ios?: unknown; default?: unknown }) => options.ios ?? options.default },
  DynamicColorIOS: (colors: { light: string }) => colors.light,
  PlatformColor: (name: string) => name,
}));
import { nativeBarSideWidth, nativeItemsTitleMaxWidth } from '../native-title-bound';

const NO_INSETS = { left: 0, right: 0 };

describe('nativeBarSideWidth', () => {
  it('matches the widths measured on an iPhone 17 Pro', () => {
    expect(nativeBarSideWidth({ items: 0 })).toBe(0);
    expect(nativeBarSideWidth({ items: 1 })).toBe(44);
    // Avatar and + as separate glass (100pt) or history and ⋯ sharing it (101pt).
    expect(nativeBarSideWidth({ items: 2 })).toBe(101);
    expect(nativeBarSideWidth({ items: 3, titleItems: 1 })).toBe(170);
  });
});

describe('nativeItemsTitleMaxWidth', () => {
  // Measured history group on the 402pt iPhone 17 Pro: its glass starts at x285.
  const HISTORY_GROUP_LEFT_EDGE = 402 - 16 - 101;

  it.each([402, 375])('ends the Climbs capsule before history on a %ipt iPhone', (frameWidth) => {
    const sides = { leading: { items: 2 }, trailing: { items: 2 } };
    const width = nativeItemsTitleMaxWidth(frameWidth, NO_INSETS, sides);
    // UIKit centres a title view that fits between the groups.
    const capsuleRight = frameWidth / 2 + width / 2;
    const historyLeft = frameWidth - 16 - nativeBarSideWidth(sides.trailing);
    expect(capsuleRight).toBeLessThanOrEqual(historyLeft);
    expect(width).toBeGreaterThan(0);
  });

  it('leaves the 402pt Climbs capsule 144pt, clear of the measured history group', () => {
    const width = nativeItemsTitleMaxWidth(402, NO_INSETS, { leading: { items: 2 }, trailing: { items: 2 } });
    expect(width).toBe(144);
    expect(402 / 2 + width / 2).toBeLessThan(HISTORY_GROUP_LEFT_EDGE);
  });

  it('gives up room for an angle beside history and never goes below zero', () => {
    const withAngle = nativeItemsTitleMaxWidth(402, NO_INSETS, {
      leading: { items: 2 },
      trailing: { items: 3, titleItems: 1 },
    });
    expect(withAngle).toBe(75);
    expect(
      nativeItemsTitleMaxWidth(320, NO_INSETS, { leading: { items: 2 }, trailing: { items: 4, titleItems: 1 } }),
    ).toBe(0);
  });
});
