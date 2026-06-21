import { useMemo } from 'react';
import { View, Pressable, StyleSheet, Platform } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import type { BoardName } from '@boardsesh/shared-schema';
import { getBoardRenderData } from '../../lib/board-details';
import { hapticLight } from '../../lib/haptics';
import { springs } from '../../theme/animations';
import { spacing, borderRadius, overlays } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { useTheme } from '../../providers/theme-provider';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { BoardImageNative } from '../BoardImageNative';

/** The minimal board shape the card renders. UserBoard, PopularBoardConfig, and
 *  BLE-resolved boards all map onto this so one card serves every section. */
export type DiscoveryBoardItem = {
  /** Stable key for the list. */
  key: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  /** Comma-separated set ids (the UserBoard wire shape). */
  setIds: string;
  title: string;
  subtitle?: string | null;
  /** When set, renders the distance badge (metres from the user). */
  distanceMeters?: number | null;
  /** When true, marks this as the currently-active board. */
  isActive?: boolean;
};

export const DISCOVERY_CARD_WIDTH = 168;

/** Distance badge copy: metres under 1km, one-decimal km above. */
function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type BoardDiscoveryCardProps = {
  item: DiscoveryBoardItem;
  onPress: (item: DiscoveryBoardItem) => void;
};

export function BoardDiscoveryCard({ item, onPress }: BoardDiscoveryCardProps) {
  const { systemColors, brandColors } = useTheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const render = useMemo(
    () =>
      getBoardRenderData({
        boardName: item.boardName,
        layoutId: item.layoutId,
        sizeId: item.sizeId,
        setIds: item.setIds.split(',').map(Number).filter(Number.isFinite),
      }),
    [item.boardName, item.layoutId, item.sizeId, item.setIds],
  );

  const thumbStyle = {
    backgroundColor: systemColors.tertiaryBackground,
    borderColor: item.isActive ? brandColors.primary : systemColors.separator,
    borderWidth: item.isActive ? 2 : StyleSheet.hairlineWidth,
  };

  return (
    <AnimatedPressable
      onPress={() => {
        hapticLight();
        onPress(item);
      }}
      onPressIn={() => (scale.value = withSpring(0.97, springs.snappy))}
      onPressOut={() => (scale.value = withSpring(1, springs.snappy))}
      accessibilityRole="button"
      style={[animatedStyle, styles.container]}
    >
      <View testID="board-card" style={[styles.thumb, thumbStyle]}>
        {render ? (
          <BoardImageNative
            frames=""
            boardName={item.boardName}
            layoutId={item.layoutId}
            sizeId={item.sizeId}
            setIds={item.setIds}
            boardWidth={render.boardWidth}
            boardHeight={render.boardHeight}
            // Resolve the thumb-sized (416px) background + a 400px overlay
            // instead of the full-res native webp (up to ~1461px). A 168px cell
            // doesn't need the native source, and decoding it on the main thread
            // for every card in three stacked carousels stutters / hangs the
            // picker. Matches ClimbListThumbnail's renderWidth so the thumb
            // background and overlay cache entries are shared across surfaces.
            renderWidth={400}
            style={styles.boardImage}
          />
        ) : (
          <View style={styles.thumbFallback}>
            <Icon name="boards" size={36} color={systemColors.tertiaryLabel} />
          </View>
        )}

        {item.isActive ? (
          <View style={styles.activeBadge}>
            <Icon name="tick" size={16} color={brandColors.primary} />
          </View>
        ) : null}

        {item.distanceMeters != null ? (
          <View style={styles.distanceBadge}>
            <Icon name="location" size={11} color={overlays.onScrim} />
            <Text variant="caption2" color={overlays.onScrim}>
              {formatDistance(item.distanceMeters)}
            </Text>
          </View>
        ) : null}
      </View>

      <Text variant="subheadline" numberOfLines={1} style={styles.title}>
        {item.title}
      </Text>
      {item.subtitle ? (
        <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
          {item.subtitle}
        </Text>
      ) : null}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  container: {
    width: DISCOVERY_CARD_WIDTH,
  },
  thumb: {
    width: DISCOVERY_CARD_WIDTH,
    height: DISCOVERY_CARD_WIDTH,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing[2],
  },
  boardImage: {
    width: '100%',
    height: '100%',
  },
  thumbFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeBadge: {
    position: 'absolute',
    top: spacing[2],
    right: spacing[2],
    width: 26,
    height: 26,
    borderRadius: borderRadius.full,
    backgroundColor: iosSystemColors.white,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 2 },
      android: { elevation: 2 },
    }),
  },
  distanceBadge: {
    position: 'absolute',
    bottom: spacing[2],
    right: spacing[2],
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
    backgroundColor: overlays.scrim,
  },
  title: {
    fontWeight: '600',
  },
});
