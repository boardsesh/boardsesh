import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { Appbar } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useUnreadNotificationCount } from '../../lib/graphql/hooks/use-notifications';
import { hapticLight } from '../../lib/haptics';
import { Icon } from '../Icon';
import { iconMap } from '../icon-map';
import { Badge } from '../Badge';
import { GlassToolbarAction } from './GlassActionToolbar';

type NotificationsToolbarActionProps = {
  variant: 'glass' | 'material';
  /** Where the bell goes — injected so the same component can serve either tab stack. */
  onPress: () => void;
};

/**
 * The notifications bell for a tab's top chrome. Owns its own unread count the
 * way `UserAvatarToolbarAction` owns its profile, so hosting chromes need no
 * new props.
 *
 * The badge is a DOT, not a count. `GlassActionToolbar` clips
 * (`overflow: 'hidden'`), so a "99+" pill would be cropped by the island's
 * rounded corner — the same constraint `BoardToolbarAction` documents. The
 * number goes in the VoiceOver label instead, where it is actually readable.
 */
export function NotificationsToolbarAction({ variant, onPress }: NotificationsToolbarActionProps) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const unreadCount = useUnreadNotificationCount();

  const handlePress = useCallback(() => {
    hapticLight();
    onPress();
  }, [onPress]);

  const label = t('ariaLabels.notifications');
  const accessibilityLabel = unreadCount > 0 ? `${label} (${unreadCount})` : label;

  // This is the component's OWN `'glass' | 'material'` prop — the hosting chrome
  // says which island it renders into — not `theme.variant`, so there is no
  // `selectByVariant` to route it through. Recorded in the variant guard's
  // ALLOWLIST next to UserAvatarToolbarAction, which is the identical case.
  if (variant === 'material') {
    return (
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
    );
  }

  return (
    <GlassToolbarAction onPress={handlePress} accessibilityLabel={accessibilityLabel}>
      <Icon name="notification" size={22} color={systemColors.label} />
      {unreadCount > 0 ? (
        // Nudged inward (top/right 2) so the island's rounded corner can't crop
        // the dot — same geometry as BoardToolbarAction's onboarding cue.
        <View style={styles.glassBadge} pointerEvents="none">
          <Badge visible color={brandColors.primary} size="small" />
        </View>
      ) : null}
    </GlassToolbarAction>
  );
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
