import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionUser } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { AvatarGroup } from '../../you/AvatarGroup';
import { useTheme } from '../../../providers/theme-provider';
import { brandColors } from '../../../theme/colors';
import { spacing, opacity } from '../../../theme/tokens';

type SessionPresenceRowProps = {
  users: SessionUser[];
  driverParticipantId?: string | null;
  selfParticipantId?: string | null;
};

/**
 * Compact "who's connected right now" row: overlapping avatars + a live count +
 * a driver indicator. Connected climbers lead the avatar cluster; if everyone is
 * mid-reconnect the cluster dims to read as offline. Renders nothing when the
 * roster is empty.
 */
export function SessionPresenceRow({ users, driverParticipantId, selfParticipantId }: SessionPresenceRowProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();

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
        userId: user.id,
        displayName: user.username,
        avatarUrl: user.avatarUrl,
      })),
    [ordered],
  );

  if (users.length === 0) return null;

  const allReconnecting = users.every((user) => user.connectionState !== 'CONNECTED');
  const driver = driverParticipantId
    ? users.find((user) => user.id === driverParticipantId)
    : undefined;
  const driverIsSelf = !!driver && driver.id === selfParticipantId;

  return (
    <View style={styles.container}>
      <View style={[styles.avatars, allReconnecting ? { opacity: opacity.subtle } : null]}>
        <AvatarGroup participants={participants} size={32} max={4} />
      </View>
      <View style={styles.text}>
        <Text variant="subheadline" style={styles.count}>
          {t('mobile.session.inPresenceCount', { count: users.length })}
        </Text>
        {driver ? (
          <View style={styles.driverRow}>
            <Icon name="lightbulb.fill" size={12} color={brandColors.warning} />
            <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
              {driverIsSelf ? t('mobile.session.inDriverLabel') : driver.username}
            </Text>
          </View>
        ) : null}
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
  driverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
});
