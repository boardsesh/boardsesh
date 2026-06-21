import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { hapticSelection } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';

type PlaylistPinButtonProps = {
  isPinned: boolean;
  onToggle: () => void;
  /** Icon edge length. Defaults to 22 (nav-header size). */
  size?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * Pin toggle used in the detail header and as a card overlay. Filled pin when
 * pinned, outline when not (mirrors web's `PushPin` / `PushPinOutlined`).
 */
export function PlaylistPinButton({ isPinned, onToggle, size = 22, style }: PlaylistPinButtonProps) {
  const { t } = useTranslation('playlists');
  const { brandColors } = useTheme();
  return (
    <Pressable
      onPress={() => {
        hapticSelection();
        onToggle();
      }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityState={{ selected: isPinned }}
      accessibilityLabel={isPinned ? t('library.pin.unpinAriaLabel') : t('library.pin.pinAriaLabel')}
      style={[styles.button, style]}
    >
      <Icon
        name={isPinned ? 'pin.fill' : 'pin'}
        size={size}
        color={isPinned ? brandColors.primary : iosSystemColors.systemGray}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
