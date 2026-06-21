import { type ReactNode, useCallback } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { Text } from '../Text';
import { ProgressiveBlur } from '../ProgressiveBlur';
import { TOP_ACTION_SIZE } from './GlassActionToolbar';

const ROW_GUTTER = spacing[4];

type CollapsingLargeTitleHeaderProps = {
  /** Optional persistent title shown as plain centred text in the islands row
   *  (e.g. the Climbs filter summary). Always visible when set; omit for no
   *  centred title (Discover/Profile/Record). */
  centerTitle?: string;
  /** Report the measured chrome height so the list can inset its top padding. */
  onHeightChange: (height: number) => void;
  /** Glass island(s) anchored to the left of the islands row. */
  leftActions?: ReactNode;
  /** Glass island(s) anchored to the right of the islands row. */
  rightActions?: ReactNode;
  /** Extra controls rendered below the islands row (e.g. a search or segmented
   *  control row). Measured into the reported chrome height. */
  children?: ReactNode;
};

/**
 * The board-agnostic floating glass chrome shared across tabs: an always-on
 * progressive blur and a left/right glass-island row. The screen renders its own
 * large in-body title at the top of its scroll content; it simply scrolls away
 * under the blur. Climbs additionally passes `centerTitle` (its filter summary),
 * which sits as a persistent plain title in the centre of the islands row — the
 * one surface that keeps a header title.
 */
export function CollapsingLargeTitleHeader({
  centerTitle,
  onHeightChange,
  leftActions,
  rightActions,
  children,
}: CollapsingLargeTitleHeaderProps) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();

  // Always-on progressive blur from the top of the screen to just below the
  // islands row; frosts content scrolling under the islands.
  const blurHeight = insets.top + spacing[1] + TOP_ACTION_SIZE + spacing[2];

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );

  return (
    <View pointerEvents="box-none" style={[styles.container, { paddingTop: insets.top }]} onLayout={handleLayout}>
      {/* Always-on progressive glass: a blur from the top of the screen down to
          just below the islands, strongest up top and fading to clear, so content
          frosts out gradually and the status-bar strip reads as glass. */}
      <ProgressiveBlur style={[styles.blur, { height: blurHeight }]} />
      {/* A standard three-section nav row: left island, a flexible centre that
          holds the optional persistent title, right island. The flex centre keeps
          a long title from sliding under the islands — it ellipsizes in the gap
          rather than overlapping them. */}
      <View pointerEvents="box-none" style={styles.row}>
        {/* Left island. */}
        {leftActions}

        {/* Flexible centre: the optional persistent plain title (Climbs filter
            summary) — plain text over the progressive blur, no pill; otherwise the
            spacer that holds the right island to the edge. Non-interactive —
            status-bar tap handles scroll-to-top. */}
        <View pointerEvents="none" style={styles.centerSection}>
          {centerTitle != null ? (
            <Text
              variant="headline"
              numberOfLines={1}
              ellipsizeMode="tail"
              color={systemColors.label}
              style={styles.centerTitle}
            >
              {centerTitle}
            </Text>
          ) : null}
        </View>

        {/* Right island. */}
        {rightActions}
      </View>

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
  // Progressive blur layer (height applied inline): spans from the top of the
  // screen down to just below the islands row, behind the islands.
  blur: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  row: {
    height: TOP_ACTION_SIZE,
    marginHorizontal: ROW_GUTTER,
    marginVertical: spacing[1],
    flexDirection: 'row',
    alignItems: 'center',
  },
  centerSection: {
    flex: 1,
    // Allow the title chip to shrink (and so ellipsize) instead of pushing the
    // islands out; a small gutter keeps it off the islands.
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[2],
  },
  centerTitle: {
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'center',
  },
});
