import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { spacing } from '../theme/tokens';

// Default width of the trailing slot (and the matching leading spacer) so the
// centered column stays optically centered before the trailing element measures.
const DEFAULT_TRAILING_MIN_WIDTH: number = spacing[12];

export function resolveDrawerHeaderTrailingWidth(layoutWidth: number, minWidth: number): number {
  return Math.max(minWidth, Math.ceil(layoutWidth));
}

type DrawerHeaderProps = {
  /** Centered column content (e.g. title + subtitle, or a name input + counts). */
  center: ReactNode;
  /** Right-aligned element (e.g. a grade, an angle, a validity check). Its width
   *  is measured at runtime and mirrored into the leading spacer so `center`
   *  stays centered regardless of the trailing element's width. */
  trailing?: ReactNode;
  trailingMinWidth?: number;
};

/**
 * Shared drawer header chassis: a centered column flanked by a measured-width
 * trailing slot and a matching leading spacer. Used by the Play Drawer (name +
 * stats + grade) and the Create Drawer (name input + start/finish + validity).
 */
export const DrawerHeader = memo(function DrawerHeader({
  center,
  trailing,
  trailingMinWidth = DEFAULT_TRAILING_MIN_WIDTH,
}: DrawerHeaderProps) {
  const [trailingWidth, setTrailingWidth] = useState(trailingMinWidth);

  useEffect(() => {
    setTrailingWidth((previous) => (previous === trailingMinWidth ? previous : trailingMinWidth));
  }, [trailingMinWidth]);

  const handleTrailingLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const measured = resolveDrawerHeaderTrailingWidth(event.nativeEvent.layout.width, trailingMinWidth);
      setTrailingWidth((previous) => (previous === measured ? previous : measured));
    },
    [trailingMinWidth],
  );

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={[styles.leadingSpacer, { width: trailingWidth }]} />
        <View style={styles.centerColumn}>{center}</View>
        <View style={[styles.trailing, { minWidth: trailingWidth }]} onLayout={handleTrailingLayout}>
          {trailing}
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    minHeight: 56,
    justifyContent: 'center',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  leadingSpacer: {
    flexShrink: 0,
  },
  centerColumn: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
  },
  trailing: {
    flexShrink: 0,
    alignItems: 'flex-end',
  },
});
