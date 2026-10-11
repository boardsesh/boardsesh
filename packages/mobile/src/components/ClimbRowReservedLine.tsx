import type { StyleProp, TextStyle } from 'react-native';
import { Text, type TextVariant } from './Text';

// A no-break space. An empty string, and on the web a plain space, can lay out
// with no height at all; this is one full line of its variant everywhere.
const BLANK_LINE = '\u00A0';

type ClimbRowReservedLineProps = {
  variant: TextVariant;
  /** The style of the line this stands in for, when that changes its height or position. */
  style?: StyleProp<TextStyle>;
  /** The same cap as the line this stands in for, when that line has one. */
  maxFontSizeMultiplier?: number;
};

/**
 * An empty line of a text variant, for a climb row line that has nothing to
 * draw yet, or nothing at all for this climb. It holds that line's height as
 * real text, so it grows with Dynamic Type exactly as the line would, and the
 * row keeps one height from its first paint. Silent to screen readers.
 */
export function ClimbRowReservedLine({ variant, style, maxFontSizeMultiplier }: ClimbRowReservedLineProps) {
  return (
    <Text
      variant={variant}
      numberOfLines={1}
      accessibilityElementsHidden
      importantForAccessibility="no"
      // Left undefined, `Text` keeps its own uncapped default.
      {...(maxFontSizeMultiplier === undefined ? null : { maxFontSizeMultiplier })}
      style={style}
    >
      {BLANK_LINE}
    </Text>
  );
}
