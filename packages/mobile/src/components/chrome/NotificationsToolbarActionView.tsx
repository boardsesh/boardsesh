import { selectByVariant } from '../../theme/variants';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Appbar } from 'react-native-paper';
import { useTheme } from '../../providers/theme-provider';
import { Badge } from '../Badge';
import { Icon } from '../Icon';
import { iconMap } from '../icon-map';
import { GlassToolbarAction, toolbarGlyphSize, useToolbarActionSize } from './GlassActionToolbar';

const uiVariantByAppearance = { glass: 'liquidGlass', material: 'material' } as const;

export function NotificationsToolbarActionView({
  variant,
  onPress: handlePress,
  unreadCount,
}: {
  variant: 'glass' | 'material';
  onPress: () => void;
  unreadCount: number;
}) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const actionSize = useToolbarActionSize();

  const label = t('ariaLabels.notifications');
  const accessibilityLabel = unreadCount > 0 ? `${label} (${unreadCount})` : label;

  return selectByVariant(uiVariantByAppearance[variant], {
    material: (
      <View>
        <Appbar.Action
          icon={iconMap['notification'].android}
          color={systemColors.label as string}
          onPress={handlePress}
          accessibilityLabel={accessibilityLabel}
        />
        {unreadCount > 0 ? (
          <View style={styles.materialBadge} pointerEvents="none">
            <Badge visible color={brandColors.primary} size="small" />
          </View>
        ) : null}
      </View>
    ),
    liquidGlass: (
      <GlassToolbarAction onPress={handlePress} accessibilityLabel={accessibilityLabel}>
        <Icon
          maxFontSizeMultiplier={1}
          name="notification"
          size={toolbarGlyphSize(22, actionSize)}
          color={systemColors.label}
        />
        {unreadCount > 0 ? (
          // Nudged inward (top/right 2) so the island's rounded corner can't crop
          // the dot — same geometry as BoardToolbarAction's onboarding cue.
          <View style={styles.glassBadge} pointerEvents="none">
            <Badge visible color={brandColors.primary} size="small" />
          </View>
        ) : null}
      </GlassToolbarAction>
    ),
  });
}

const styles = StyleSheet.create({
  glassBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
  },
  materialBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
  },
});
