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
  it.each([1.3, 1.5, 2])('fits all rows at font scale %s without switch-dependent sizing', (fontScale) => {
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
    expect(preview.height).toBe(preview.windowHeight + 60 * fontScale);
  });
});
