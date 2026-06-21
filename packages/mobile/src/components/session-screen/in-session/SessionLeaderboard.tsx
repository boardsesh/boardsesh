import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionFeedParticipant } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { type IconName } from '../../icon-map';
import { PressableAvatar } from '../../PressableAvatar';
import { SectionHeader } from '../../SectionHeader';
import { useTheme } from '../../../providers/theme-provider';
import { withAlpha } from '../../../theme/colors';
import { iosSystemColors } from '../../../theme/ios-colors';
import { spacing, borderRadius } from '../../../theme/tokens';

type SessionLeaderboardProps = {
  participants: SessionFeedParticipant[];
  selfUserId?: string | null;
};

/**
 * Ranked roster — the social heart of the live view. Climbers sort by sends,
 * then flashes; your own row is tinted. Hidden when fewer than two climbers have
 * logged anything (no leaderboard of one).
 */
export function SessionLeaderboard({ participants, selfUserId }: SessionLeaderboardProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();

  const ranked = useMemo(
    () => [...participants].sort((a, b) => b.sends - a.sends || b.flashes - a.flashes),
    [participants],
  );

  if (ranked.length <= 1) return null;

  return (
    <View>
      {/* The footer sits inside the list's 16px gutter and SectionHeader self-
          insets 16px, so bleed the header back by 16 to keep its label flush
          with the screen gutter (matching the in-body history header). */}
      <View style={styles.sectionHeaderBleed}>
        <SectionHeader title={t('mobile.session.inLeaderboardTitle')} />
      </View>
      <View style={[styles.list, { backgroundColor: systemColors.secondaryBackground }]}>
        {ranked.map((participant, index) => {
          const isSelf = !!selfUserId && participant.userId === selfUserId;
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
              <PressableAvatar
                userId={participant.userId}
                uri={participant.avatarUrl}
                name={participant.displayName}
                size={32}
              />
              <View style={styles.nameColumn}>
                <Text variant="subheadline" style={styles.name} numberOfLines={1}>
                  {participant.displayName ?? t('mobile.session.inLeaderboardClimber')}
                </Text>
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
  sectionHeaderBleed: {
    marginHorizontal: -spacing[4],
  },
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
