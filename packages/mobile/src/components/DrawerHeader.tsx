import { memo, useCallback, useState, type ReactNode } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { spacing } from '../theme/tokens';

// Default width of the trailing slot (and the matching leading spacer) so the
// centered column stays optically centered before the trailing element measures.
const DEFAULT_TRAILING_MIN_WIDTH: number = spacing[12];

type DrawerHeaderProps = {
  /** Centered column content (e.g. title + subtitle, or a name input + counts). */
  center: ReactNode;
  /** Left-aligned element on the same row as `center`/`trailing` (e.g. an on-wall
   *  status). When provided, BOTH flanks take the wider of the two natural widths
   *  so `center` stays optically screen-centered (the leading element sits left,
   *  the trailing element right, the centered name between them). Omit it (the
   *  default) to keep the original behaviour: an auto-width spacer mirroring
   *  `trailing`. */
  leading?: ReactNode;
  /** Right-aligned element (e.g. a grade, an angle, a validity check). Its width
   *  is measured at runtime and mirrored into the leading slot so `center`
   *  stays centered regardless of the trailing element's width. */
  trailing?: ReactNode;
  trailingMinWidth?: number;
};

/**
 * Shared drawer header chassis: a centered column flanked by measured-width
 * leading/trailing slots. With no `leading`, an auto-width spacer mirrors the
 * trailing element (Create Drawer; ordinary Play Drawer headers). With a
 * `leading` element, both flanks size to the wider of the two so the title stays
 * centered. Used by the Play Drawer (name + stats + grade, plus an optional
 * on-wall status on the left).
 */
export const DrawerHeader = memo(function DrawerHeader({
  center,
  leading,
  trailing,
  trailingMinWidth = DEFAULT_TRAILING_MIN_WIDTH,
}: DrawerHeaderProps) {
  const [trailingWidth, setTrailingWidth] = useState(trailingMinWidth);
  const [leadingWidth, setLeadingWidth] = useState(0);

  const handleTrailingLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.ceil(event.nativeEvent.layout.width);
    setTrailingWidth((previous) => (previous === measured ? previous : measured));
  }, []);

  const handleLeadingLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.ceil(event.nativeEvent.layout.width);
    setLeadingWidth((previous) => (previous === measured ? previous : measured));
  }, []);

  // With a leading element both flanks share the wider natural width, so the
  // centered name stays screen-centered instead of drifting toward the narrower
  // (grade) side. The inner measure views size to their content (flexShrink 0),
  // so the onLayout widths are intrinsic — not the constrained slot width. The
  // `trailingMinWidth` floor matches the no-leading branch's trailing minWidth.
  const hasLeading = leading != null;
  const sideWidth = Math.max(leadingWidth, trailingWidth, trailingMinWidth);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        {hasLeading ? (
          <View style={[styles.side, { width: sideWidth }]}>
            <View style={styles.sideMeasure} onLayout={handleLeadingLayout}>
              {leading}
            </View>
          </View>
        ) : (
          <View style={[styles.leadingSpacer, { width: trailingWidth }]} />
        )}
        <View style={styles.centerColumn}>{center}</View>
        {hasLeading ? (
          <View style={[styles.side, styles.sideTrailing, { width: sideWidth }]}>
            <View style={styles.sideMeasure} onLayout={handleTrailingLayout}>
              {trailing}
            </View>
          </View>
        ) : (
          <View style={[styles.trailing, { minWidth: trailingMinWidth }]} onLayout={handleTrailingLayout}>
            {trailing}
          </View>
        )}
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
  // Equal-width flanks used when a leading element is present.
  side: {
    flexShrink: 0,
    alignItems: 'flex-start',
  },
  sideTrailing: {
    alignItems: 'flex-end',
  },
  sideMeasure: {
    flexShrink: 0,
  },
});
