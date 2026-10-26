import { View, StyleSheet, type ViewProps } from 'react-native';
import { HorizontalSafeAreaApplied, useHorizontalSafeArea } from '../hooks/use-horizontal-safe-area';

/** HIG readable content guide: prose and forms stay within 672pt on wide windows. */
export const READABLE_CONTENT_WIDTH = 672;
export const readableColumnStyle = StyleSheet.create({
  column: { width: '100%', maxWidth: READABLE_CONTENT_WIDTH, alignSelf: 'center' },
}).column;

/**
 * The readable column, kept clear of the side safe area: on iPhone Duo the tab
 * rail and status bar sit on the trailing edge, and the column's lists and cards
 * would run under them. The padding widens the cap by the same amount, so the
 * content keeps 672pt on a wide window. Everything inside counts as inset already.
 */
export function ReadableColumn({ style, ...props }: ViewProps) {
  const { left, right } = useHorizontalSafeArea();
  const insetStyle =
    left > 0 || right > 0
      ? { paddingLeft: left, paddingRight: right, maxWidth: READABLE_CONTENT_WIDTH + left + right }
      : null;
  return (
    <HorizontalSafeAreaApplied>
      <View {...props} style={[readableColumnStyle, insetStyle, style]} />
    </HorizontalSafeAreaApplied>
  );
}
