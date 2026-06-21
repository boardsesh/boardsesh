import { type ReactNode } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { SectionHeader } from './SectionHeader';
import { ActivityIndicator } from './ActivityIndicator';
import { spacing } from '../theme/tokens';

export type HorizontalScrollSectionProps = {
  title: string;
  /** Horizontally-laid-out card children (playlist cards, beta cards, …). */
  children: ReactNode;
  /** Fires when the user scrolls near the right edge — drives pagination. */
  onEndReached?: () => void;
  /** True while the first page is loading (renders a centered spinner). */
  loading?: boolean;
  /** True while a subsequent page is loading (renders a trailing spinner). */
  isLoadingMore?: boolean;
  /** Trailing header affordance (e.g. "See all") — expands the shelf to a full list. */
  actionLabel?: string;
  onActionPress?: () => void;
  /** Height of the loading row / minimum shelf height, sized to the cards the
   *  shelf holds (120-tall playlist cards vs 192-tall beta cards). */
  minHeight?: number;
};

// Right-edge slop (px) at which onEndReached fires, so the next page starts
// loading before the user hits the very end of the scroller.
const END_REACHED_THRESHOLD = 200;
const DEFAULT_MIN_HEIGHT = 160;

/**
 * Horizontal card scroller with a section title and an optional "See all"
 * affordance. Uses a ScrollView (the loaded card count per shelf is bounded)
 * and fires `onEndReached` as the content scrolls within
 * `END_REACHED_THRESHOLD` of the right edge. Generic over its children —
 * playlist shelves on Discover and the beta-links shelf on profiles share it.
 */
export function HorizontalScrollSection({
  title,
  children,
  onEndReached,
  loading,
  isLoadingMore,
  actionLabel,
  onActionPress,
  minHeight = DEFAULT_MIN_HEIGHT,
}: HorizontalScrollSectionProps) {
  return (
    <View style={styles.section}>
      <SectionHeader title={title} actionLabel={actionLabel} onActionPress={onActionPress} />
      {loading ? (
        <View style={[styles.loadingRow, { height: minHeight }]}>
          <ActivityIndicator size="small" />
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          scrollEventThrottle={16}
          onScroll={
            onEndReached
              ? ({ nativeEvent }) => {
                  const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
                  const distanceFromEnd = contentSize.width - (contentOffset.x + layoutMeasurement.width);
                  if (distanceFromEnd < END_REACHED_THRESHOLD) onEndReached();
                }
              : undefined
          }
        >
          {children}
          {isLoadingMore ? (
            <View style={styles.footerLoading}>
              <ActivityIndicator size="small" />
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: spacing[2],
  },
  scrollContent: {
    paddingHorizontal: spacing[4],
    gap: spacing[4],
    alignItems: 'flex-start',
  },
  loadingRow: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerLoading: {
    width: 48,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
