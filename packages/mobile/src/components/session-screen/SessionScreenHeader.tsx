import { Pressable, StyleSheet, View } from 'react-native';
import { GestureDetector, type PanGesture } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { brandColors } from '../../theme/colors';
import { spacing } from '../../theme/tokens';

type SessionScreenHeaderProps = {
  onClose: () => void;
  sessionActive: boolean;
  /** When set, a share button floats at the trailing edge to invite climbers. */
  onShare?: () => void;
  /**
   * Show a short "Invite" label beside the share glyph to teach the affordance.
   * Set while the climber is solo; collapses to the icon alone once a friend
   * joins (a clear contextual label, the HIG-preferred alternative to a coachmark).
   */
  inviteHint?: boolean;
  /** Swipe-down-to-dismiss gesture (the header doubles as the drag handle). */
  dragGesture: PanGesture;
};

/**
 * Compact header strip for the session overlay. Left: chevron-down to minimize
 * (session stays alive — the tab icon then blinks). Center: contextual title.
 * Right: a share button to invite climbers while a session is live. The whole
 * strip is also a drag handle — swipe it down to dismiss the overlay.
 */
export function SessionScreenHeader({
  onClose,
  sessionActive,
  onShare,
  inviteHint,
  dragGesture,
}: SessionScreenHeaderProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();

  const title = sessionActive ? t('mobile.session.headerActive') : t('mobile.session.headerStart');

  return (
    <GestureDetector gesture={dragGesture}>
      <View style={styles.row}>
      <Pressable
        onPress={onClose}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.session.minimize')}
        style={styles.iconButton}
      >
        <Icon name="chevron.down" size={26} color={systemColors.label} />
      </Pressable>
      <Text variant="title3" color={systemColors.label} style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {onShare ? (
          <Pressable
            onPress={onShare}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.session.invite')}
            style={styles.shareButton}
          >
            {inviteHint ? (
              <Text variant="subheadline" color={brandColors.primary} style={styles.shareLabel}>
                {t('mobile.session.inviteAction')}
              </Text>
            ) : null}
            <Icon name="share" size={22} color={brandColors.primary} />
          </Pressable>
        ) : (
          <View style={styles.iconButton} />
        )}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontWeight: '600',
  },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing[1],
    minWidth: 40,
    height: 40,
    paddingLeft: spacing[2],
  },
  shareLabel: {
    fontWeight: '600',
  },
});
