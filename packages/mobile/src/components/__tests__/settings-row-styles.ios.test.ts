import { describe, expect, it, vi } from 'vitest';

// Settings rows sit inside SwiftUI Buttons, where a hierarchical foreground
// style follows the window tint and turned every title, value and chevron
// lilac on the root stack. The row styles must be absolute UIKit label colours.
vi.mock('react-native', () => ({ PlatformColor: (name: string) => ({ semantic: [name] }) }));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  foregroundStyle: (style: unknown) => ({ $type: 'foregroundStyle', style }),
  font: (params: unknown) => ({ $type: 'font', params }),
}));

import {
  CHEVRON,
  FOOTNOTE,
  PRIMARY_LABEL,
  ROW_ICON,
  SECONDARY_LABEL,
  TERTIARY_LABEL,
} from '../settings-row-styles.ios';

describe('settings row styles (iOS)', () => {
  it.each([
    ['PRIMARY_LABEL', PRIMARY_LABEL, 'label'],
    ['SECONDARY_LABEL', SECONDARY_LABEL, 'secondaryLabel'],
    ['TERTIARY_LABEL', TERTIARY_LABEL, 'tertiaryLabel'],
  ])('%s is the fixed %s PlatformColor, not a tint-relative hierarchical style', (_name, modifier, colour) => {
    expect(modifier).toEqual({ $type: 'foregroundStyle', style: { semantic: [colour] } });
  });

  it('sizes glyphs by text style so they scale with Dynamic Type, not the fixed 24pt default', () => {
    expect(ROW_ICON).toEqual({ $type: 'font', params: { textStyle: 'body' } });
    expect(CHEVRON).toEqual({ $type: 'font', params: { textStyle: 'footnote', weight: 'semibold' } });
    expect(FOOTNOTE).toEqual({ $type: 'font', params: { textStyle: 'footnote' } });
  });
});
