import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { GroupedNotification } from '@boardsesh/shared-schema';
import { formatTickRelativeTime } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Avatar } from '../Avatar';
import { PressableSurface } from '../PressableSurface';
import { AvatarGroup } from '../you/AvatarGroup';
import { NotificationClimbThumbnail, useNotificationClimbRender } from './NotificationClimbThumbnail';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { actorSummary, notificationCopy, notificationIconName } from './notification-copy';

const AVATAR_SIZE = 40;
const GROUP_AVATAR_SIZE = 28;
/** Matches `Badge`'s `size="small"` dot, which this row used to render. */
const UNREAD_DOT_SIZE = 8;

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
 * The leading slot is board art when the row is about a climb, and the actor's
 * avatar otherwise. A climb row drops the type glyph: the board art already says
 * what kind of row it is, and stacking a glyph and an avatar on a 44pt tile
 * reads as clutter.
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

  const climbRender = useNotificationClimbRender(notification);

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
      {climbRender ? (
        <NotificationClimbThumbnail render={climbRender} actor={actors[0]} />
      ) : (
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
      )}

      <View style={styles.copy}>
        <Text variant="subheadline" numberOfLines={2} style={isRead ? undefined : styles.unreadBody}>
          {body}
        </Text>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {formatTickRelativeTime(notification.createdAt)}
        </Text>
      </View>

      {/* A plain View, deliberately NOT `Badge`. Badge's Liquid Glass variant is
          an `Animated.View` carrying `entering={FadeIn.springify()}` and
          `exiting={FadeOut.duration(150)}` — right for the toolbar bell, wrong
          inside a virtualized list. FlashList reuses a cell's subtree for a
          different item, so a recycled cell whose notification flips read↔unread
          mounts/unmounts this node mid-scroll: a spring entrance per recycled
          unread row, and on the exit a dot that lingers 150ms over a row already
          showing a READ notification. Same 8px dot, no layout animation. */}
      {isRead ? null : (
        <View style={[styles.unreadDot, { backgroundColor: brandColors.primary }]} pointerEvents="none" />
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
    width: UNREAD_DOT_SIZE,
    height: UNREAD_DOT_SIZE,
    borderRadius: UNREAD_DOT_SIZE / 2,
  },
});
