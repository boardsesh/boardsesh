import { PressableSurface } from '../PressableSurface';
import { memo, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { hapticLight } from '../../lib/haptics';
import { overlays, spacing } from '../../theme/tokens';
import { PlaylistPreviewSquare } from './PlaylistPreviewSquare';
import { PlaylistPinButton } from './PlaylistPinButton';

// Tile edge lengths per variant. Grid cards sit two-up in the smart/pinned
// sections; scroll cards are larger and live in horizontal scrollers.
const GRID_SQUARE = 64;
const SCROLL_SQUARE = 120;

export type PlaylistCardProps = {
  name: string;
  climbCount: number;
  color?: string;
  icon?: string;
  /** `grid` = compact 2-up tile; `scroll` = larger horizontal-scroller card. */
  variant: 'grid' | 'scroll';
  /** Index into the preview's fallback colour palette. */
  index?: number;
  /** Optional byline shown under the name. Defaults to localized climb count. */
  metaLabel?: string;
  /**
   * The playlist's grade band, already formatted ("V3–V5"). Drawn as a pill on
   * the preview's bottom-left corner, so a card with one is no taller than a
   * card without, and read out after the byline.
   */
  gradeLabel?: string | null;
  onPress: () => void;
  /** When set, renders a pin toggle overlay on the preview (library cards). */
  isPinned?: boolean;
  onTogglePin?: () => void;
};

export const PlaylistCard = memo(function PlaylistCard({
  name,
  climbCount,
  color,
  icon,
  variant,
  index = 0,
  metaLabel,
  gradeLabel,
  onPress,
  isPinned,
  onTogglePin,
}: PlaylistCardProps) {
  const { t } = useTranslation('playlists');

  const handlePress = useCallback(() => {
    hapticLight();
    onPress();
  }, [onPress]);

  const isScroll = variant === 'scroll';
  const squareSize = isScroll ? SCROLL_SQUARE : GRID_SQUARE;
  const countLabel = t('detail.climbCount', { count: climbCount });
  const displayMeta = metaLabel ?? countLabel;
  const accessibilityLabel = gradeLabel
    ? `${name}, ${displayMeta}, ${t('library.gradeBand', { band: gradeLabel })}`
    : `${name}, ${displayMeta}`;

  // Preview square + optional pin overlay (top-right). The pin sits in its own
  // Pressable so tapping it toggles without triggering the card's navigation.
  const preview = (
    <View>
      <PlaylistPreviewSquare color={color} icon={icon} index={index} size={squareSize} />
      {gradeLabel ? (
        <View style={styles.gradeOverlay} pointerEvents="none">
          <Text variant="caption2" numberOfLines={1} style={styles.gradeText}>
            {gradeLabel}
          </Text>
        </View>
      ) : null}
      {onTogglePin ? (
        <PlaylistPinButton isPinned={!!isPinned} onToggle={onTogglePin} size={16} style={styles.pinOverlay} />
      ) : null}
    </View>
  );

  if (isScroll) {
    return (
      <PressableSurface
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={[styles.scrollCard, { width: SCROLL_SQUARE }]}
      >
        {preview}
        <Text variant="subheadline" numberOfLines={1} style={styles.scrollName}>
          {name}
        </Text>
        <Text variant="caption1" numberOfLines={1} style={styles.meta}>
          {displayMeta}
        </Text>
      </PressableSurface>
    );
  }

  return (
    <PressableSurface
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={styles.gridCard}
    >
      {preview}
      <View style={styles.gridInfo}>
        <Text variant="subheadline" numberOfLines={1} style={styles.gridName}>
          {name}
        </Text>
        <Text variant="caption1" numberOfLines={1} style={styles.meta}>
          {displayMeta}
        </Text>
      </View>
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  gridCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  gridInfo: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  gridName: {
    fontWeight: '600',
  },
  scrollCard: {
    gap: spacing[2],
  },
  scrollName: {
    fontWeight: '600',
  },
  meta: {
    opacity: 0.6,
  },
  gradeOverlay: {
    position: 'absolute',
    left: spacing[1],
    bottom: spacing[1],
    maxWidth: '90%',
    paddingHorizontal: spacing[1],
    paddingVertical: 2,
    borderRadius: 8,
    backgroundColor: overlays.scrim,
  },
  gradeText: {
    color: overlays.onScrim,
    fontWeight: '600',
  },
  pinOverlay: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
});
