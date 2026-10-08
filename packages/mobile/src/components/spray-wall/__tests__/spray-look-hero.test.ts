import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (color: string) => color,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
}));
import { fitSprayLookHero } from '../spray-look-hero';
import { captionBlockHeight } from '../../board-look/board-look-card-metrics';
import { spacing } from '../../../theme/tokens';

const lineHeights = { title: 24, description: 20 };
describe('spray look hero content budget', () => {
  it.each([1, 1.2])('keeps a portrait photo and its caption clear of page dots at font scale %s', (fontScale) => {
    const railSlotHeight = 420;
    const thumb = fitSprayLookHero({
      aspect: 0.6,
      windowWidth: 393,
      railSlotHeight,
      captionLineHeights: lineHeights,
      fontScale,
    });
    expect(thumb).not.toBeNull();
    const occupiedHeight = thumb!.height + captionBlockHeight(lineHeights, fontScale, 0) + spacing[4] * 2;
    expect(occupiedHeight).toBeLessThanOrEqual(railSlotHeight);
  });
});
