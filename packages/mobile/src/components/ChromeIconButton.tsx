// The one glyph button for top bars and headers: close (xmark), back (chevron),
// minimise (chevron down), more (ellipsis). Sized and coloured from
// `topBarFor(variant)` so a sheet's X, a native header's X and a hand-built header's
// chevron are the same object. See docs/ai-design-guidelines.md, "Top-bar buttons".
//
// Liquid Glass: a 17pt semibold glyph in the label colour, in a 44pt target. `filled`
// draws the target as a `systemColors.fill` circle, for chrome we draw ourselves
// (SheetTopBar, the tick and queue headers). `bare` is for a native header,
// where UIKit already draws the glass around the view: the frame stays small
// and a hit slop makes up the 44.
//
// Material: a 24dp glyph in a 48dp target with a borderless ripple, the M3
// standard icon button: onSurface for navigation (close, back), onSurfaceVariant
// for an action (more, edit, help). No fill either way.
import React from 'react';
import { StyleSheet, type ColorValue, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import type { IconName } from './icon-map';
import { useTheme } from '../providers/theme-provider';
import { topBarFor } from '../theme/top-bar';

export type ChromeIconButtonAppearance = 'filled' | 'bare';

type ChromeIconButtonProps = {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  disabled?: boolean;
  /** See the file comment. Default `filled`. */
  appearance?: ChromeIconButtonAppearance;
  /**
   * `navigation` leaves or folds the surface (close, back, minimise); `action`
   * does something on it (more, edit, help, history). Only Material colours
   * them apart. Default `navigation`.
   */
  role?: 'navigation' | 'action';
  /** Overrides the glyph colour (a toggled-on state, say). */
  color?: ColorValue;
  testID?: string;
  /** Positioning, or a floating surface's own background and shadow. */
  style?: StyleProp<ViewStyle>;
};

/** The side of a glyph button's footprint, for a spacer that balances one. */
export function useChromeIconButtonSize(appearance: ChromeIconButtonAppearance = 'filled'): number {
  const { variant } = useTheme();
  const spec = topBarFor(variant);
  return appearance === 'bare' ? spec.nativeBarGlyphFrame : spec.iconTarget;
}

export const ChromeIconButton = React.memo(function ChromeIconButton({
  icon,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  appearance = 'filled',
  role = 'navigation',
  color,
  testID,
  style,
}: ChromeIconButtonProps) {
  const { variant, systemColors } = useTheme();
  const spec = topBarFor(variant);
  const glyphColor = color ?? systemColors[role === 'action' ? spec.actionGlyphColor : spec.navigationGlyphColor];
  const bare = appearance === 'bare';
  const frame = bare ? spec.nativeBarGlyphFrame : spec.iconTarget;
  const fill = !bare && spec.glyphFilled ? systemColors.fill : undefined;

  return (
    <PressableSurface
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      feedback="opacity"
      rippleBorderless
      hitSlop={Math.max(0, (spec.iconTarget - frame) / 2)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      style={[
        styles.target,
        { width: frame, height: frame, borderRadius: frame / 2, backgroundColor: fill },
        disabled ? { opacity: spec.disabledOpacity } : null,
        style,
      ]}
    >
      <Icon
        name={icon}
        size={spec.glyphSize}
        weight="semibold"
        color={disabled && spec.disabledInLabelColor ? systemColors.label : glyphColor}
      />
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  target: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
