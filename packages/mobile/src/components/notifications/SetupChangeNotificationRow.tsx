import { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { GroupedNotification } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Avatar } from '../Avatar';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { notificationCopy, notificationIconName } from './notification-copy';
import { formatSetupSummary } from '../report-problem/setup-summary';
import { canUndoSetupChange, type UndoSetupChange } from './setup-change-notice';

const AVATAR_SIZE = 40;
const UNREAD_DOT_SIZE = 8;

/** How this row's last Undo ended, when the notice's own state doesn't say. */
type RowEnding = 'already_undone' | 'not_allowed' | 'failed';

type SetupChangeNotificationRowProps = {
  notification: GroupedNotification;
  /** Stable handler from the screen: opens the board. */
  onPress: (notification: GroupedNotification) => void;
  /** Stable handler from the screen: confirms, then puts the old setup back, and says how it ended. */
  onUndo: UndoSetupChange;
};

/**
 * "A climber changed the setup of {board}": the notice that a climber's
 * suggestion changed a board for everyone, sent to the board's creator and the
 * gym's owner and admins, with Undo while the change is still on the board
 * (docs/product/directory-reports.md, "Suggested setup").
 *
 * Like the follow request row, Undo is a button of its own beside the row's
 * tap target (which opens the board), never inside it. Once the change is
 * undone, or the board changed again since, the row says so instead. The
 * screen's cache moves `setupChangeState` on, so the line survives a scroll.
 * Who undid it (someone else first) and an Undo the server no longer allows
 * are this row's own state, so a recycled cell shows them only for the notice
 * they belong to.
 */
export function SetupChangeNotificationRow({ notification, onPress, onUndo }: SetupChangeNotificationRowProps) {
  const { t } = useTranslation('notifications');
  const { systemColors, brandColors } = useTheme();
  // Keyed by the row's uuid: FlashList hands a recycled cell, state and all, to
  // a different notification, and an undo in flight belongs to one notice.
  const [inFlightUuid, setInFlightUuid] = useState<string | null>(null);
  const [ending, setEnding] = useState<{ uuid: string; kind: RowEnding } | null>(null);
  const pending = inFlightUuid === notification.uuid;
  const ended = ending?.uuid === notification.uuid ? ending.kind : null;
  const failed = ended === 'failed';
  // A second tap lands before `pending` re-renders the button disabled: one
  // confirm and one request per notice.
  const undoing = useRef(new Set<string>());

  const copy = notificationCopy(notification, t('actorSummary.fallback'));
  const body = t(copy.textI18nKey, copy.params);
  const notice = notification.directoryNotice;
  const setupAfter = notice?.setupAfter ?? null;
  const boardType = notice?.boardType ?? null;
  const after = useMemo(
    () => (setupAfter && boardType ? formatSetupSummary(boardType, setupAfter) : null),
    [setupAfter, boardType],
  );
  const state = notice?.setupChangeState ?? null;
  const undoable = canUndoSetupChange(notification) && ended !== 'not_allowed';

  const handlePress = useCallback(() => onPress(notification), [onPress, notification]);
  const undo = useCallback(async () => {
    const { uuid } = notification;
    if (undoing.current.has(uuid)) return;
    undoing.current.add(uuid);
    setInFlightUuid(uuid);
    setEnding(null);
    try {
      const outcome = await onUndo(notification);
      if (outcome === 'already_undone' || outcome === 'not_allowed') setEnding({ uuid, kind: outcome });
    } catch {
      // No connection, or a server error: the line says to try again.
      setEnding({ uuid, kind: 'failed' });
    } finally {
      undoing.current.delete(uuid);
      setInFlightUuid(null);
    }
  }, [notification, onUndo]);
  const handleUndo = useCallback(() => void undo(), [undo]);

  const statusLine =
    state === 'CHANGED_SINCE'
      ? t('setupChange.changedSince')
      : state === 'UNDONE'
        ? ended === 'already_undone'
          ? t('setupChange.alreadyUndone')
          : t('setupChange.undone')
        : ended === 'not_allowed'
          ? t('setupChange.notAllowed')
          : failed
            ? t('setupChange.failed')
            : null;

  return (
    <View
      style={[
        styles.row,
        {
          borderBottomColor: systemColors.separator,
          backgroundColor: notification.isRead ? 'transparent' : systemColors.fill,
        },
      ]}
    >
      <PressableSurface
        onPress={handlePress}
        feedback="opacity"
        accessibilityRole="button"
        accessibilityLabel={after ? `${body}. ${t('setupChange.now', { setup: after })}` : body}
        style={styles.identity}
      >
        <View style={styles.avatarSlot}>
          <Avatar size={AVATAR_SIZE} />
          <View style={[styles.typeGlyph, { backgroundColor: systemColors.secondaryBackground }]}>
            <Icon name={notificationIconName(notification.type)} size={12} color={systemColors.secondaryLabel} />
          </View>
        </View>
        <View style={styles.copy}>
          <Text variant="subheadline" numberOfLines={2} style={notification.isRead ? undefined : styles.unreadBody}>
            {body}
          </Text>
          {after ? (
            <Text variant="footnote" numberOfLines={2} color={systemColors.secondaryLabel}>
              {t('setupChange.now', { setup: after })}
            </Text>
          ) : null}
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {formatRelativeTime(notification.createdAt)}
          </Text>
        </View>
        {notification.isRead ? null : (
          <View style={[styles.unreadDot, { backgroundColor: brandColors.primary }]} pointerEvents="none" />
        )}
      </PressableSurface>
      {undoable ? (
        <View style={styles.actions}>
          <Button
            title={t('setupChange.undo')}
            accessibilityLabel={
              notice?.boardName ? t('setupChange.undoLabel', { board: notice.boardName }) : t('setupChange.undo')
            }
            variant="outlined"
            size="small"
            loading={pending}
            disabled={pending}
            onPress={handleUndo}
            testID="setup-change-undo"
          />
        </View>
      ) : null}
      {statusLine ? (
        <Text
          variant="footnote"
          accessibilityRole={failed ? 'alert' : undefined}
          accessibilityLiveRegion="polite"
          color={failed ? brandColors.error : systemColors.secondaryLabel}
          style={styles.status}
          testID="setup-change-status"
        >
          {statusLine}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: spacing[2],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[4],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
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
  // Line the button and the status up under the text, past the avatar.
  actions: {
    flexDirection: 'row',
    paddingLeft: AVATAR_SIZE + spacing[3],
  },
  status: {
    paddingLeft: AVATAR_SIZE + spacing[3],
  },
});
