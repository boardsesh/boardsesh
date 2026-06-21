import { useEffect, useRef } from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { type IconName } from '../../icon-map';
import { PressableAvatar } from '../../PressableAvatar';
import { Card } from '../../Card';
import { SectionHeader } from '../../SectionHeader';
import { useTheme } from '../../../providers/theme-provider';
import { gradeBadgeColor } from '../../you/profile-chart-colors';
import { spacing } from '../../../theme/tokens';
import { hapticSuccess } from '../../../lib/haptics';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { SessionGradeChart } from './SessionGradeChart';
import { SessionTimer } from './SessionTimer';
import type { HardestSend } from './hardest-sends';

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
  const { systemColors, brandColors } = useTheme();
  const { formatGrade, formatGradeByDifficultyId } = useGradeFormat();

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
          labelColor={systemColors.secondaryLabel}
        />
        <StatTile
          value={flashes}
          label={t('mobile.session.inStatsFlashes')}
          icon="flash"
          tint={brandColors.warning}
          labelColor={systemColors.secondaryLabel}
        />
        <Card style={styles.statCard}>
          <View style={styles.statTileBody}>
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
        </Card>
      </View>

      {hardestSends.length > 0 ? (
        <Card>
          <View style={styles.hardestBody}>
            <Text variant="caption1" color={systemColors.secondaryLabel}>
              {t(hardestSends.length > 1 ? 'mobile.session.inStatsHardestEach' : 'mobile.session.inStatsHardest')}
            </Text>
            {hardestSends.map((send, index) => (
              <View key={send.userId ?? `solo-${index}`} style={styles.hardestRow}>
                {send.userId ? (
                  <PressableAvatar userId={send.userId} uri={send.avatarUrl} name={send.displayName} size={28} />
                ) : null}
                {/* Grade as bold coloured text — no pill, per the chip cleanup. */}
                <Text variant="title3" color={gradeBadgeColor(send.grade)} style={styles.hardestGrade}>
                  {formatGradeByDifficultyId(send.difficultyId) ?? formatGrade(send.grade) ?? send.grade}
                </Text>
                {send.climbName ? (
                  <Text variant="body" numberOfLines={1} style={styles.hardestName}>
                    {send.climbName}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        </Card>
      ) : null}

      {gradeDistribution.length > 0 ? (
        <View>
          <View style={styles.sectionHeaderBleed}>
            <SectionHeader title={t('mobile.session.inStatsGrades')} />
          </View>
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
  labelColor: ColorValue;
};

function StatTile({ value, label, icon, tint, labelColor }: StatTileProps) {
  return (
    <Card style={styles.statCard}>
      <View style={styles.statTileBody}>
        <Icon name={icon} size={18} color={tint} />
        <Text variant="title2" style={styles.statValue}>
          {value}
        </Text>
        <Text variant="caption1" color={labelColor}>
          {label}
        </Text>
      </View>
    </Card>
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
  // The three stat tiles share the row width evenly; Card owns the surface and
  // padding, so the tile only sets its flex.
  statCard: {
    flex: 1,
  },
  statTileBody: {
    alignItems: 'center',
    gap: spacing[1],
  },
  statValue: {
    fontWeight: '700',
  },
  hardestBody: {
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
  // SectionHeader self-insets 16px; SessionAnalytics renders inside the list's
  // 16px gutter, so bleed the header back by 16 to keep the label flush.
  sectionHeaderBleed: {
    marginHorizontal: -spacing[4],
  },
});
