import { useEffect, useRef } from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { type IconName } from '../../icon-map';
import { Avatar } from '../../Avatar';
import { useTheme } from '../../../providers/theme-provider';
import { gradeBadgeColor } from '../../you/profile-chart-colors';
import { brandColors } from '../../../theme/colors';
import { spacing, borderRadius } from '../../../theme/tokens';
import { hapticSuccess } from '../../../lib/haptics';
import { SessionGradeChart } from './SessionGradeChart';
import { SessionTimer } from './SessionTimer';

/** One climber's hardest send. `userId` set only for multi-climber parties (so
 *  the solo case renders without an avatar). */
export type HardestSend = {
  userId?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  grade: string;
  climbName?: string | null;
};

type SessionAnalyticsProps = {
  sends: number;
  flashes: number;
  /** Aggregate session-hardest grade — drives the celebration haptic. */
  hardestGrade: string | null;
  /** Hardest send(s) to display: one entry solo, one per climber in a party. */
  hardestSends: HardestSend[];
  /** Session start time for the live duration cell (null until summary loads). */
  startedAt: string | null;
  gradeDistribution: SessionGradeDistributionItem[];
};

/**
 * Analytics block for the live in-session view: a row of stat cells
 * (Sent / Flashed / Attempted / Duration), a hardest-send celebration, and the
 * grade-distribution chart. Replaces the old SessionStatsHeader. Fires a single
 * tasteful success haptic the first time a new hardest grade lands.
 */
export function SessionAnalytics({
  sends,
  flashes,
  hardestGrade,
  hardestSends,
  startedAt,
  gradeDistribution,
}: SessionAnalyticsProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();

  // Celebrate a fresh hardest grade once. Seeded with the initial grade so the
  // first render (which may already carry a hardest) doesn't buzz; only a later
  // change to a different grade fires the haptic.
  const lastHardestGrade = useRef<string | null>(hardestGrade);
  useEffect(() => {
    if (hardestGrade && hardestGrade !== lastHardestGrade.current) {
      hapticSuccess();
    }
    lastHardestGrade.current = hardestGrade;
  }, [hardestGrade]);

  return (
    <View style={styles.container}>
      <View style={styles.statsRow}>
        <StatTile
          value={sends}
          label={t('mobile.session.inStatsSends')}
          icon="tick"
          tint={brandColors.success}
          background={systemColors.secondaryBackground}
          labelColor={systemColors.secondaryLabel}
        />
        <StatTile
          value={flashes}
          label={t('mobile.session.inStatsFlashes')}
          icon="flash"
          tint={brandColors.warning}
          background={systemColors.secondaryBackground}
          labelColor={systemColors.secondaryLabel}
        />
        <View style={[styles.statCard, { backgroundColor: systemColors.secondaryBackground }]}>
          <Icon name="clock" size={18} color={systemColors.secondaryLabel} />
          {startedAt ? (
            <SessionTimer startedAt={startedAt} />
          ) : (
            <Text variant="title2" style={styles.statValue}>
              —
            </Text>
          )}
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('mobile.session.inStatsDuration')}
          </Text>
        </View>
      </View>

      {hardestSends.length > 0 ? (
        <View style={[styles.hardestCard, { backgroundColor: systemColors.secondaryBackground }]}>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t(hardestSends.length > 1 ? 'mobile.session.inStatsHardestEach' : 'mobile.session.inStatsHardest')}
          </Text>
          {hardestSends.map((send, index) => (
            <View key={send.userId ?? `solo-${index}`} style={styles.hardestRow}>
              {send.userId ? <Avatar uri={send.avatarUrl} name={send.displayName} size={28} /> : null}
              {/* Grade as bold coloured text — no pill, per the chip cleanup. */}
              <Text variant="title3" color={gradeBadgeColor(send.grade)} style={styles.hardestGrade}>
                {send.grade}
              </Text>
              {send.climbName ? (
                <Text variant="body" numberOfLines={1} style={styles.hardestName}>
                  {send.climbName}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {gradeDistribution.length > 0 ? (
        <View style={styles.section}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
            {t('mobile.session.inStatsGrades')}
          </Text>
          <SessionGradeChart distribution={gradeDistribution} />
        </View>
      ) : null}
    </View>
  );
}

type StatTileProps = {
  value: number;
  label: string;
  icon: IconName;
  tint: ColorValue;
  background: ColorValue;
  labelColor: ColorValue;
};

function StatTile({ value, label, icon, tint, background, labelColor }: StatTileProps) {
  return (
    <View style={[styles.statCard, { backgroundColor: background }]}>
      <Icon name={icon} size={18} color={tint} />
      <Text variant="title2" style={styles.statValue}>
        {value}
      </Text>
      <Text variant="caption1" color={labelColor}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing[3],
  },
  statsRow: {
    flexDirection: 'row',
    gap: spacing[2],
  },
  statCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing[3],
    borderRadius: borderRadius.lg,
    gap: spacing[1],
  },
  statValue: {
    fontWeight: '700',
  },
  hardestCard: {
    padding: spacing[3],
    borderRadius: borderRadius.lg,
    gap: spacing[2],
  },
  hardestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  hardestGrade: {
    fontWeight: '700',
    minWidth: 44,
  },
  hardestName: {
    flex: 1,
  },
  section: {
    gap: spacing[2],
  },
  sectionLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
