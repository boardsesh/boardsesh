import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: () => undefined },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  StyleSheet: { create: <T>(styles: T): T => styles, hairlineWidth: 0.5 },
}));

import { COUNT_BADGE_MAX_FONT_SCALE, countBadgeBox, countBadgeText } from '../count-badge-style';
import { textStyles } from '../../theme/typography';

// HIG: text is never under 11pt; M3 labelSmall is 11sp. The count is set in the
// caption2 variant (11pt), not a hand-set size, in a box that is a floor so it
// grows with the text instead of clipping it.
describe('count badge style', () => {
  it('sets no font size of its own, so caption2 (11pt) applies', () => {
    expect(countBadgeText).not.toHaveProperty('fontSize');
    expect(textStyles.caption2.fontSize).toBe(11);
  });

  it('uses min sizes, not a fixed height or width', () => {
    expect(countBadgeBox).not.toHaveProperty('height');
    expect(countBadgeBox).not.toHaveProperty('width');
    expect(countBadgeBox.minHeight).toBeGreaterThanOrEqual(textStyles.caption2.lineHeight);
    expect(countBadgeBox.minWidth).toBe(countBadgeBox.minHeight);
  });

  it('caps Dynamic Type at 1.3x', () => {
    expect(COUNT_BADGE_MAX_FONT_SCALE).toBe(1.3);
  });
});
