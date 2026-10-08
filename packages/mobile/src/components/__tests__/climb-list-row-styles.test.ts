vi.mock('../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: <T>(styles: T): T => styles,
    hairlineWidth: 0.5,
  },
  Platform: { OS: 'ios', select: () => undefined },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
}));
vi.mock('../climb-list-thumbnail-metrics', () => ({ THUMBNAIL_WIDTH: 48 }));

import { CLIMB_ROW_GUTTER, climbListRowStyles } from '../climb-list-row-styles';

// HIG Layout: 16pt side margins on iPhone; M3 Lists: 16dp item padding. The row
// used 8pt, so the thumbnails sat closer to the edge than every header above.
describe('climb list row margins', () => {
  it('pads the row 16pt on both sides', () => {
    expect(CLIMB_ROW_GUTTER).toBe(16);
    expect(climbListRowStyles.contentRow.paddingHorizontal).toBe(16);
  });

  it('starts the separator at the text column, after the gutter, thumbnail and gap', () => {
    expect(climbListRowStyles.separator.marginLeft).toBe(16 + 48 + 12);
  });
});
