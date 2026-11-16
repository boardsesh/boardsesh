import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: () => undefined },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
}));

import { CLIMB_ROW_FIELD_IDS, DEFAULT_CLIMB_ROW_DISPLAY } from '../../../../lib/climb-row-display';
import { climbRowLayout, type ClimbRowLayoutInput } from '../../../climb-row-layout';
import { climbRowPreviewLayout } from '../climb-row-preview-layout';

describe('preview viewport', () => {
  it('keeps the 117 point minimum at default text size', () => {
    expect(climbRowPreviewLayout(1).windowHeight).toBe(117);
    expect(climbRowPreviewLayout(1).height).toBe(177);
  });
  // React Native's iOS fontScale at xxxLarge and AX3, and the subheadline preset
  // chips' ramp there (21/15 and 36/15).
  it.each([
    { fontScale: 1.353, presetScale: 21 / 15 },
    { fontScale: 2.643, presetScale: 36 / 15 },
  ])('fits all rows at font scale $fontScale without switch-dependent sizing', ({ fontScale, presetScale }) => {
    const allFields = { ...DEFAULT_CLIMB_ROW_DISPLAY };
    for (const field of CLIMB_ROW_FIELD_IDS) allFields[field] = true;
    const typeScale: ClimbRowLayoutInput['typeScale'] = { body: { lineHeight: 24 }, footnote: { lineHeight: 20 } };
    const preview = climbRowPreviewLayout(fontScale, typeScale);
    for (const thumbnail of [false, true]) {
      const row = climbRowLayout({
        display: { ...allFields, thumbnail },
        fontScale,
        typeScale,
        supportsMirroring: true,
        surface: { showAscentStatus: true, showPlaylistChips: true, detailLine: 'computed' },
      });
      expect(preview.windowHeight).toBeGreaterThanOrEqual(row.estimatedHeight);
    }
    expect(preview.height).toBeCloseTo(preview.windowHeight + 60 * presetScale, 6);
  });
});
