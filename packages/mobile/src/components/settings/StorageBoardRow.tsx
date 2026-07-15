import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

export type StorageBoardRowProps = {
  scopeKey: string;
  /** The layout, e.g. "Kilter Board Original". */
  title: string;
  /** Board + size, e.g. "Kilter · 12 x 14". */
  subtitle: string;
  /** Footprint, e.g. "About 180 MB · 41,000 climbs". */
  caption: string;
  /** Whether this scope is still kept offline, or is leftover data. */
  statusLabel: string;
  removeLabel: string;
  removeAccessibilityLabel: string;
  isRemoving: boolean;
  isDisabled: boolean;
  showSeparator: boolean;
  onRemove: (scopeKey: string) => void;
};

/**
 * One downloaded board scope.
 *
 * Deliberately NOT built on ListRow: that renders one `numberOfLines={1}` subtitle,
 * which silently truncates away the footprint and the offline status — i.e. exactly
 * the two facts this screen exists to show.
 *
 * Memoized and fed only primitives plus a stable `onRemove`, so removing one board
 * doesn't re-render the others.
 */
function StorageBoardRowComponent({
  scopeKey,
  title,
  subtitle,
  caption,
  statusLabel,
  removeLabel,
  removeAccessibilityLabel,
  isRemoving,
  isDisabled,
  showSeparator,
  onRemove,
}: StorageBoardRowProps) {
  const { systemColors } = useTheme();
  const handleRemove = useCallback(() => onRemove(scopeKey), [onRemove, scopeKey]);

  return (
    <View>
      <View style={styles.row}>
        <View style={styles.text}>
          <Text variant="body" numberOfLines={1}>
            {title}
          </Text>
          <Text variant="subheadline" style={{ color: systemColors.secondaryLabel }} numberOfLines={1}>
            {subtitle}
          </Text>
          <Text variant="subheadline" numberOfLines={1}>
            {caption}
          </Text>
          <Text variant="caption1" style={{ color: systemColors.tertiaryLabel }} numberOfLines={2}>
            {statusLabel}
          </Text>
        </View>
        <Button
          title={removeLabel}
          accessibilityLabel={removeAccessibilityLabel}
          onPress={handleRemove}
          variant="text"
          size="small"
          role="destructive"
          loading={isRemoving}
          disabled={isDisabled}
        />
      </View>
      {showSeparator ? <View style={[styles.separator, { backgroundColor: systemColors.separator }]} /> : null}
    </View>
  );
}

export const StorageBoardRow = memo(StorageBoardRowComponent);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  text: {
    flex: 1,
    gap: spacing[1],
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing[4],
  },
});
