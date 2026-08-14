import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { GroupedNotification } from '@boardsesh/shared-schema';
import { formatTickRelativeTime } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Badge } from '../Badge';
import { Avatar } from '../Avatar';
import { PressableSurface } from '../PressableSurface';
import { AvatarGroup } from '../you/AvatarGroup';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { actorSummary, notificationCopy, notificationIconName } from './notification-copy';

const AVATAR_SIZE = 40;
const GROUP_AVATAR_SIZE = 28;

type NotificationRowProps = {
  notification: GroupedNotification;
  /** Stable handler from the screen — marks read, then navigates. */
  onPress: (notification: GroupedNotification) => void;
};

/**
 * One grouped-notification row. Props are the group object plus a single stable
 * `onPress`, which is what lets `memo` actually bail: the screen's `renderItem`
 * passes no inline closures and no scalar derived from the list (a `unreadCount`
 * prop here would re-render every row on every mark-read).
 *
 * The whole row is ONE tap target. The avatars deliberately pass `userId:
 * undefined` so `PressableAvatar` degrades to a plain avatar rather than
 * nesting a competing pressable inside the row's own.
 */
export const NotificationRow = memo(function NotificationRow({ notification, onPress }: NotificationRowProps) {
  const { t } = useTranslation('notifications');
  const { systemColors, brandColors } = useTheme();

  const { actors, actorCount, isRead } = notification;
  const showAvatarGroup = actorCount > 1 && actors.length > 1;

  const summary = actorSummary(notification, {
    primary: t('actorSummary.fallback'),
    secondary: t('actorSummary.secondaryFallback'),
  });
  const actorLabel = summary.kind === 'literal' ? summary.text : t(summary.textI18nKey, summary.params);

  const copy = notificationCopy(notification, actorLabel);
  const body = t(copy.textI18nKey, copy.params);

  const participants = useMemo(
    () =>
      actors.map((actor) => ({
        // No userId: the row owns the tap, so avatars stay non-pressable.
        userId: undefined,
        displayName: actor.displayName,
        avatarUrl: actor.avatarUrl,
      })),
    [actors],
  );

  const handlePress = useCallback(() => onPress(notification), [onPress, notification]);

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={body}
      style={[
        styles.row,
        {
          borderBottomColor: systemColors.separator,
          backgroundColor: isRead ? 'transparent' : systemColors.fill,
        },
      ]}
    >
      <View style={styles.avatarSlot}>
        {showAvatarGroup ? (
          <AvatarGroup participants={participants} size={GROUP_AVATAR_SIZE} max={3} />
        ) : (
          <Avatar uri={actors[0]?.avatarUrl} name={actors[0]?.displayName} size={AVATAR_SIZE} />
        )}
        {/* Type glyph, tucked at the avatar's trailing-bottom corner so the row
            reads "who" first and "what kind" second, like web's avatar fallback. */}
        <View style={[styles.typeGlyph, { backgroundColor: systemColors.secondaryBackground }]}>
          <Icon name={notificationIconName(notification.type)} size={12} color={systemColors.secondaryLabel} />
        </View>
      </View>

      <View style={styles.copy}>
        <Text variant="subheadline" numberOfLines={2} style={isRead ? undefined : styles.unreadBody}>
          {body}
        </Text>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {formatTickRelativeTime(notification.createdAt)}
        </Text>
      </View>

      {isRead ? null : (
        <View style={styles.unreadDot} pointerEvents="none">
          <Badge visible color={brandColors.primary} size="small" />
        </View>
      )}
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[4],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatarSlot: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeGlyph: {
    position: 'absolute',
    right: -4,
    bottom: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: spacing[1],
  },
  unreadBody: {
    fontWeight: '600',
  },
  unreadDot: {
    alignSelf: 'center',
  },
});
