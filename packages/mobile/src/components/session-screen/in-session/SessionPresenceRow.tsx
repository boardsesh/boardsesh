import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionUser } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { AvatarGroup } from '../../you/AvatarGroup';
import { spacing, opacity } from '../../../theme/tokens';

type SessionPresenceRowProps = {
  users: SessionUser[];
};

/**
 * Compact "who's connected right now" row: overlapping avatars + a live count.
 * Connected climbers lead the avatar cluster; if everyone is mid-reconnect the
 * cluster dims to read as offline. Renders nothing when the roster is empty.
 */
export function SessionPresenceRow({ users }: SessionPresenceRowProps) {
  const { t } = useTranslation('session');

  // Connected climbers first so the visible (non-overflow) avatars favour the
  // people actually present. The AvatarGroup participant shape carries no
  // connection state, so dimming is expressed at the cluster level.
  const ordered = useMemo(() => {
    const connected = users.filter((user) => user.connectionState === 'CONNECTED');
    const reconnecting = users.filter((user) => user.connectionState !== 'CONNECTED');
    return [...connected, ...reconnecting];
  }, [users]);

  const participants = useMemo(
    () =>
      ordered.map((user) => ({
        // user.id is the connection id; user.userId is the stable DB user id the
        // profile route expects. Unauthenticated connections have no userId, so
        // their avatar stays non-tappable rather than linking to a dead profile.
        userId: user.userId,
        displayName: user.username,
        avatarUrl: user.avatarUrl,
      })),
    [ordered],
  );

  if (users.length === 0) return null;

  const allReconnecting = users.every((user) => user.connectionState !== 'CONNECTED');

  return (
    <View style={styles.container}>
      <View style={[styles.avatars, allReconnecting ? { opacity: opacity.subtle } : null]}>
        <AvatarGroup participants={participants} size={32} max={4} />
      </View>
      <View style={styles.text}>
        <Text variant="subheadline" style={styles.count}>
          {t('mobile.session.inPresenceCount', { count: users.length })}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  avatars: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  text: {
    flex: 1,
    gap: 2,
  },
  count: {
    fontWeight: '600',
  },
});
