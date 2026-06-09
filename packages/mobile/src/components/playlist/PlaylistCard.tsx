import { memo, useCallback } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { hapticLight } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
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

  // Preview square + optional pin overlay (top-right). The pin sits in its own
  // Pressable so tapping it toggles without triggering the card's navigation.
  const preview = (
    <View>
      <PlaylistPreviewSquare color={color} icon={icon} index={index} size={squareSize} />
      {onTogglePin ? (
        <PlaylistPinButton isPinned={!!isPinned} onToggle={onTogglePin} size={16} style={styles.pinOverlay} />
      ) : null}
    </View>
  );

  if (isScroll) {
    return (
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${countLabel}`}
        style={[styles.scrollCard, { width: SCROLL_SQUARE }]}
      >
        {preview}
        <Text variant="subheadline" numberOfLines={1} style={styles.scrollName}>
          {name}
        </Text>
        <Text variant="caption1" numberOfLines={1} style={styles.meta}>
          {countLabel}
        </Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${countLabel}`}
      style={styles.gridCard}
    >
      {preview}
      <View style={styles.gridInfo}>
        <Text variant="subheadline" numberOfLines={1} style={styles.gridName}>
          {name}
        </Text>
        <Text variant="caption1" numberOfLines={1} style={styles.meta}>
          {countLabel}
        </Text>
      </View>
    </Pressable>
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
