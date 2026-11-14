import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { GroupedNotification } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Avatar } from '../Avatar';
import { Button } from '../Button';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { formatRelativeTime } from '../../lib/format-relative-time';
import type { FollowRequestAnswer } from '../../lib/graphql/hooks/use-notifications';
import type { HttpActionScope } from '../../lib/graphql/use-http-action-scope';
import { notificationCopy } from './notification-copy';

const AVATAR_SIZE = 40;
const UNREAD_DOT_SIZE = 8;

export type AnswerFollowRequest = (
  input: { notification: GroupedNotification; answer: FollowRequestAnswer },
  options: { readonly signal: AbortSignal },
) => Promise<{ readonly assertCurrent: () => void }>;

type FollowRequestNotificationRowProps = {
  notification: GroupedNotification;
  /** Stable handler from the screen: opens the requester's profile. */
  onPress: (notification: GroupedNotification) => void;
  /** Stable handler from the screen: approves or declines the request. */
  onAnswer: AnswerFollowRequest;
  captureAction: HttpActionScope['capture'];
};

/**
 * A follow request to a private account, answered from the inbox.
 *
 * Unlike every other row this one is not a single tap target: Approve and
 * Decline are buttons of their own, so the profile link is a pressable beside
 * them rather than around them. A pressable wrapping the buttons would hide
 * them from VoiceOver, which reads an accessible container as one element.
 *
 * The row only tracks which answer is in flight. On success the screen's cache
 * drops the row; on failure the buttons come back with a line saying why.
 */
export function FollowRequestNotificationRow({
  notification,
  onPress,
  onAnswer,
  captureAction,
}: FollowRequestNotificationRowProps) {
  const { t } = useTranslation('notifications');
  const { systemColors, brandColors } = useTheme();
  // Keyed by the row's uuid: FlashList hands a recycled cell, state and all, to
  // a different notification, and an answer in flight belongs to one request.
  const [inFlight, setInFlight] = useState<{ uuid: string; answer: FollowRequestAnswer } | null>(null);
  const [failedUuid, setFailedUuid] = useState<string | null>(null);
  const mounted = useRef(true);
  const currentUuid = useRef(notification.uuid);
  useLayoutEffect(() => {
    currentUuid.current = notification.uuid;
  }, [notification.uuid]);
  type Pending = { uuid: string };
  const currentAttempt = useRef<Pending | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A successful cache write removes this row before its mutation promise
      // necessarily settles. Retire local effects without cancelling that
      // authorized cache publication; the screen still owns pending actions.
      currentAttempt.current = null;
    };
  }, []);
  const pending = inFlight?.uuid === notification.uuid ? inFlight.answer : null;
  const failed = failedUuid === notification.uuid;

  const requester = notification.actors[0];
  const actor = requester?.displayName || t('actorSummary.fallback');
  const copy = notificationCopy(notification, actor);
  const body = t(copy.textI18nKey, copy.params);

  const handlePress = useCallback(() => onPress(notification), [onPress, notification]);
  const answer = useCallback(
    async (next: FollowRequestAnswer) => {
      const previous = currentAttempt.current;
      if (previous?.uuid === notification.uuid) return;
      let action: ReturnType<HttpActionScope['capture']>;
      try {
        action = captureAction();
      } catch {
        return;
      }
      const attempt: Pending = { uuid: notification.uuid };
      const isCurrent = () =>
        mounted.current &&
        currentAttempt.current === attempt &&
        currentUuid.current === attempt.uuid &&
        action.isCurrent();
      currentAttempt.current = attempt;
      if (!isCurrent()) {
        action.finish();
        return;
      }
      setInFlight({ uuid: notification.uuid, answer: next });
      setFailedUuid(null);
      try {
        const result = await onAnswer(
          { notification, answer: next },
          {
            signal: action.signal,
          },
        );
        if (!isCurrent()) return;
        action.assertView();
        result.assertCurrent();
      } catch {
        if (!isCurrent()) return;
        setFailedUuid(notification.uuid);
        setInFlight(null);
        currentAttempt.current = null;
      } finally {
        action.finish();
      }
    },
    [notification, onAnswer, captureAction],
  );
  const approve = useCallback(() => void answer('approve'), [answer]);
  const decline = useCallback(() => void answer('decline'), [answer]);

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
        accessibilityLabel={body}
        style={styles.identity}
      >
        <Avatar uri={requester?.avatarUrl} name={requester?.displayName} size={AVATAR_SIZE} />
        <View style={styles.copy}>
          <Text variant="subheadline" numberOfLines={2} style={notification.isRead ? undefined : styles.unreadBody}>
            {body}
          </Text>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {formatRelativeTime(notification.createdAt)}
          </Text>
        </View>
        {notification.isRead ? null : (
          <View style={[styles.unreadDot, { backgroundColor: brandColors.primary }]} pointerEvents="none" />
        )}
      </PressableSurface>
      <View style={styles.actions}>
        <Button
          title={t('followRequest.approve')}
          accessibilityLabel={t('followRequest.approveLabel', { actor })}
          variant="filled"
          size="small"
          loading={pending === 'approve'}
          disabled={pending !== null}
          onPress={approve}
        />
        <Button
          title={t('followRequest.decline')}
          accessibilityLabel={t('followRequest.declineLabel', { actor })}
          variant="outlined"
          size="small"
          loading={pending === 'decline'}
          disabled={pending !== null}
          onPress={decline}
        />
      </View>
      {failed ? (
        <Text variant="footnote" accessibilityRole="alert" color={brandColors.error}>
          {t('followRequest.failed')}
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
  actions: {
    flexDirection: 'row',
    gap: spacing[2],
    // Line the buttons up under the text, past the avatar.
    paddingLeft: AVATAR_SIZE + spacing[3],
  },
});
