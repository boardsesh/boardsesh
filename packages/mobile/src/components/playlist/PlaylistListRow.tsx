import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { hapticLight } from '../../lib/haptics';
import { PlaylistPreviewSquare } from './PlaylistPreviewSquare';

const THUMB_SIZE = 44;

export type PlaylistListRowProps = {
  /** Identifies the row to its parent so a single stable handler can serve every row. */
  uuid: string;
  name: string;
  /** Nullable on some board configs — coerced to 0 so the count never renders "NaN". */
  climbCount?: number | null;
  color?: string;
  icon?: string;
  /** Index into the preview's fallback colour palette. */
  index?: number;
  /**
   * Called with this row's `uuid`. Passing the uuid back (rather than a
   * per-row closure) lets the parent supply one stable callback for the whole
   * list, so `React.memo` here actually prevents re-renders on page appends.
   */
  onPressUuid: (uuid: string) => void;
};

/**
 * A scannable vertical playlist row for the "My Playlists" list: a small
 * preview thumbnail, the name, its climb count, and a disclosure chevron. Unlike
 * the generic `ListRow` (32px leading), this sizes the thumbnail to read clearly
 * in a dense alphabetical list.
 *
 * Memoised so that draining the rest of the library (each page append grows the
 * list) doesn't re-render every already-mounted row. The separator lives in the
 * list's `ItemSeparatorComponent`, keeping every prop here primitive + stable.
 */
export const PlaylistListRow = memo(function PlaylistListRow({
  uuid,
  name,
  climbCount,
  color,
  icon,
  index = 0,
  onPressUuid,
}: PlaylistListRowProps) {
  const { t } = useTranslation('playlists');

  const countLabel = t('detail.climbCount', { count: climbCount ?? 0 });

  const handlePress = useCallback(() => {
    hapticLight();
    onPressUuid(uuid);
  }, [onPressUuid, uuid]);

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="opacity"
      opacityTo={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${countLabel}`}
    >
      <View style={styles.row}>
        <PlaylistPreviewSquare color={color} icon={icon} index={index} size={THUMB_SIZE} />
        <View style={styles.info}>
          <Text variant="body" numberOfLines={1} style={styles.name}>
            {name}
          </Text>
          <Text variant="subheadline" numberOfLines={1} style={styles.meta}>
            {countLabel}
          </Text>
        </View>
        <Icon name="chevron.right" size={14} color={iosSystemColors.systemGray4} />
      </View>
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    minHeight: 60,
  },
  info: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  name: {
    fontWeight: '600',
  },
  meta: {
    opacity: 0.6,
  },
});

/**
 * The hairline between rows. Lives here (next to the row that defines its inset)
 * so `all.tsx` can pass it straight to the list's `ItemSeparatorComponent`,
 * keeping the separator out of `renderItem` and its dependency list.
 */
export const PlaylistListRowSeparator = memo(function PlaylistListRowSeparator() {
  const { systemColors } = useTheme();
  return <View style={[separatorStyles.separator, { backgroundColor: systemColors.separator }]} />;
});

const separatorStyles = StyleSheet.create({
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing[4] + THUMB_SIZE + spacing[3],
  },
});
