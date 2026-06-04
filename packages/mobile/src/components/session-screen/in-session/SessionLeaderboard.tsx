import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionFeedParticipant } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { type IconName } from '../../icon-map';
import { Avatar } from '../../Avatar';
import { SectionHeader } from '../../SectionHeader';
import { useTheme } from '../../../providers/theme-provider';
import { brandColors, withAlpha } from '../../../theme/colors';
import { iosSystemColors } from '../../../theme/ios-colors';
import { spacing, borderRadius } from '../../../theme/tokens';

type SessionLeaderboardProps = {
  participants: SessionFeedParticipant[];
  /** DB user id of the driver (resolved from the participant roster upstream) —
   *  the same id space as `participant.userId`, so it actually matches. */
  driverUserId?: string | null;
  selfUserId?: string | null;
};

/**
 * Ranked roster — the social heart of the live view. Climbers sort by sends,
 * then flashes; the driver gets a lightbulb badge and your own row is tinted.
 * Hidden when fewer than two climbers have logged anything (no leaderboard of
 * one).
 */
export function SessionLeaderboard({ participants, driverUserId, selfUserId }: SessionLeaderboardProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();

  const ranked = useMemo(
    () => [...participants].sort((a, b) => b.sends - a.sends || b.flashes - a.flashes),
    [participants],
  );

  if (ranked.length <= 1) return null;

  return (
    <View>
      <SectionHeader title={t('mobile.session.inLeaderboardTitle')} />
      <View style={[styles.list, { backgroundColor: systemColors.secondaryBackground }]}>
        {ranked.map((participant, index) => {
          // Both ids are DB user ids (driverUserId is resolved from the roster
          // upstream), so they match a participant's userId directly.
          const isSelf = !!selfUserId && participant.userId === selfUserId;
          const isDriver = !!driverUserId && participant.userId === driverUserId;
          return (
            <View
              key={participant.userId}
              style={[
                styles.row,
                index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: systemColors.separator } : null,
                isSelf ? { backgroundColor: withAlpha(brandColors.primary, 0.1) } : null,
              ]}
            >
              <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.rank}>
                {index + 1}
              </Text>
              <Avatar uri={participant.avatarUrl} name={participant.displayName} size={32} />
              <View style={styles.nameColumn}>
                <Text variant="subheadline" style={styles.name} numberOfLines={1}>
                  {participant.displayName ?? t('mobile.session.inLeaderboardClimber')}
                </Text>
                {isDriver ? (
                  <View style={styles.driverRow}>
                    <Icon name="lightbulb.fill" size={11} color={brandColors.warning} />
                    <Text variant="caption2" color={systemColors.secondaryLabel}>
                      {t('mobile.session.inDriverLabel')}
                    </Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.chips}>
                {participant.sends > 0 ? (
                  <Chip icon="tick" label={`${participant.sends}`} tint={brandColors.success} />
                ) : null}
                {participant.flashes > 0 ? (
                  <Chip icon="flash" label={`${participant.flashes}`} tint={brandColors.warning} />
                ) : null}
                {participant.attempts > 0 ? (
                  <Chip icon="circle" label={`${participant.attempts}`} tint={iosSystemColors.systemGray} />
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function Chip({ icon, label, tint }: { icon: IconName; label: string; tint: string }) {
  return (
    <View style={[styles.chip, { backgroundColor: withAlpha(tint, 0.15) }]}>
      <Icon name={icon} size={12} color={tint} />
      <Text variant="caption1" color={tint} style={styles.chipLabel}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  rank: {
    width: 20,
    textAlign: 'center',
    fontWeight: '700',
  },
  nameColumn: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontWeight: '600',
  },
  driverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  chips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing[2],
    paddingVertical: 3,
    borderRadius: borderRadius.full,
  },
  chipLabel: {
    fontWeight: '600',
  },
});
