import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionFeedItem } from '@boardsesh/shared-schema';
import { parseTickTime } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Card } from '../Card';
import { brandColors } from '../../theme/colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type WeeklyRollup = {
  sessions: number;
  sends: number;
  flashes: number;
  streakWeeks: number;
};

/**
 * Compute the "this week" rollup + week-streak purely from the already-loaded
 * feed pages — no extra query. `now` is injected so the calculation is
 * deterministic and testable. Streak = number of consecutive ISO-ish weeks
 * (trailing 7-day windows back from `now`) that contain at least one session.
 */
function computeRollup(sessions: SessionFeedItem[], now: number): WeeklyRollup {
  const weekAgo = now - WEEK_MS;
  let weeklySessions = 0;
  let weeklySends = 0;
  let weeklyFlashes = 0;
  for (const session of sessions) {
    if (parseTickTime(session.lastTickAt).valueOf() >= weekAgo) {
      weeklySessions += 1;
      weeklySends += session.totalSends;
      weeklyFlashes += session.totalFlashes;
    }
  }

  // Streak: walk back week-by-week from `now`; stop at the first empty week.
  const weekIndexes = new Set<number>();
  for (const session of sessions) {
    const ageMs = now - parseTickTime(session.lastTickAt).valueOf();
    if (ageMs < 0) continue;
    weekIndexes.add(Math.floor(ageMs / WEEK_MS));
  }
  let streakWeeks = 0;
  while (weekIndexes.has(streakWeeks)) streakWeeks += 1;

  return { sessions: weeklySessions, sends: weeklySends, flashes: weeklyFlashes, streakWeeks };
}

export function SessionsFeedHeader({ sessions, now }: { sessions: SessionFeedItem[]; now: number }) {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();

  const rollup = useMemo(() => computeRollup(sessions, now), [sessions, now]);

  // Nothing logged in the trailing week → skip the rollup entirely so the feed
  // doesn't lead with a wall of zeros.
  if (rollup.sessions === 0) return null;

  return (
    <Card style={styles.card}>
      <Text variant="subheadline" style={styles.headline}>
        {rollup.streakWeeks > 1
          ? t('mobile.sessions.streak', { count: rollup.streakWeeks })
          : t('mobile.sessions.weeklySends', { count: rollup.sends })}
      </Text>
      <View style={styles.tiles}>
        <View style={[styles.tile, { backgroundColor: systemColors.fill }]}>
          <Text variant="title2">{rollup.sessions}</Text>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('mobile.sessions.weekly.sessions')}
          </Text>
        </View>
        <View style={[styles.tile, { backgroundColor: systemColors.fill }]}>
          <Text variant="title2" color={brandColors.success}>
            {rollup.sends}
          </Text>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('mobile.sessions.weekly.sends')}
          </Text>
        </View>
        <View style={[styles.tile, { backgroundColor: systemColors.fill }]}>
          <Text variant="title2" color={brandColors.warning}>
            {rollup.flashes}
          </Text>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('mobile.sessions.weekly.flashes')}
          </Text>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: spacing[4], marginTop: spacing[4] },
  headline: { fontWeight: '600', marginBottom: spacing[3] },
  tiles: { flexDirection: 'row', gap: spacing[2] },
  tile: {
    flex: 1,
    borderRadius: borderRadius.md,
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    gap: spacing[1],
  },
});
