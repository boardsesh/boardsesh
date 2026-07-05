import { memo } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import type { BoardDownloadState } from './board-offline-state';

type BoardOfflineToggleProps = {
  state: BoardDownloadState;
  onPress: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
};

const HIT_SLOP = { top: spacing[2], bottom: spacing[2], left: spacing[2], right: spacing[2] };

/**
 * Compact plain-RN offline control for a board row — an icon button (never an
 * @expo/ui Host, to keep the FlashList light). Dumb + memoised: it renders the
 * glyph for the primitive `state` and calls `onPress`; the parent owns the
 * toggle logic and the status text. Downloading shows a spinner (no tap target).
 */
function BoardOfflineToggleComponent({ state, onPress, accessibilityLabel, disabled }: BoardOfflineToggleProps) {
  const { systemColors, brandColors } = useTheme();

  if (state === 'downloading') {
    return <ActivityIndicator size="small" style={styles.control} />;
  }

  const iconName =
    state === 'downloaded' ? 'offline.downloaded' : state === 'pending' ? 'offline.pending' : 'offline.download';
  const iconColor = state === 'downloaded' ? brandColors.primary : systemColors.secondaryLabel;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: state === 'downloaded', disabled: !!disabled }}
      style={styles.control}
    >
      <Icon name={iconName} size={22} color={iconColor} />
    </Pressable>
  );
}

export const BoardOfflineToggle = memo(BoardOfflineToggleComponent);

const styles = StyleSheet.create({
  control: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
