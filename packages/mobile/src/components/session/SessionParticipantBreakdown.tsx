import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionFeedParticipant } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { Avatar } from '../Avatar';
import { ListRow } from '../ListRow';
import { SectionHeader } from '../SectionHeader';
import { brandColors, withAlpha } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

/** Per-climber sends/flashes/attempts breakdown. Renders nothing for solo sessions. */
export function SessionParticipantBreakdown({ participants }: { participants: SessionFeedParticipant[] }) {
  const { t } = useTranslation('session');
  const { t: tYou } = useTranslation('you');

  if (participants.length <= 1) return null;

  return (
    <View>
      <SectionHeader title={t('mobileDetail.participants')} />
      {participants.map((participant) => (
        <ListRow
          key={participant.userId}
          title={participant.displayName ?? tYou('mobile.unknownName')}
          leading={<Avatar uri={participant.avatarUrl} name={participant.displayName} size={32} />}
          showSeparator
          trailing={
            <View style={styles.chips}>
              {participant.sends > 0 && (
                <Chip icon="tick" label={`${participant.sends}`} tint={brandColors.success} />
              )}
              {participant.flashes > 0 && (
                <Chip icon="flash" label={`${participant.flashes}`} tint={brandColors.warning} />
              )}
              {participant.attempts > 0 && (
                <Chip icon="circle" label={`${participant.attempts}`} tint={iosSystemColors.systemGray} />
              )}
            </View>
          }
        />
      ))}
    </View>
  );
}

function Chip({ icon, label, tint }: { icon: IconName; label: string; tint: string }) {
  return (
    <View style={[styles.chip, { backgroundColor: withAlpha(tint, 0.15) }]}>
      <Icon name={icon} size={11} color={tint} />
      <Text variant="caption1" color={tint} style={styles.chipLabel}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  chipLabel: { fontWeight: '600' },
});
