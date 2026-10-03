import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { parseTickTime, type ClimbVerdict } from '@boardsesh/profile-stats';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { AscentStatusMark } from '../../ascent-marks';
import { formatLedgerDate } from './day-label';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';

type LogbookVerdictProps = {
  verdict: ClimbVerdict;
  todayKey: string;
  yesterdayKey: string;
};

const MARK_SIZE = 40;

/** The Logbook card's headline: where the climber stands on this climb, in one line. */
export const LogbookVerdict = memo(function LogbookVerdict({ verdict, todayKey, yesterdayKey }: LogbookVerdictProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();

  if (verdict.kind === 'untried') {
    return (
      <View accessible accessibilityRole="header" style={styles.row}>
        <View style={[styles.untriedMark, { backgroundColor: systemColors.fill }]}>
          <Icon name="history" size={20} color={systemColors.secondaryLabel} />
        </View>
        <Text variant="headline" style={styles.headline}>
          {t('mobile.logbook.noEntries')}
        </Text>
      </View>
    );
  }

  const dayKey = parseTickTime(verdict.climbedAt).format('YYYY-MM-DD');
  let when: string;
  if (dayKey === todayKey) when = t('mobile.logbook.whenToday');
  else if (dayKey === yesterdayKey) when = t('mobile.logbook.whenYesterday');
  else when = t('mobile.logbook.whenOnDate', { date: formatLedgerDate(dayKey, todayKey) });

  let headline: string;
  switch (verdict.kind) {
    case 'flash':
      headline = t('mobile.logbook.verdictFlash', { angle: verdict.angle, when });
      break;
    case 'send':
      headline = t('mobile.logbook.verdictSend', { angle: verdict.angle, when });
      break;
    default:
      headline = t('mobile.logbook.verdictAttempt', { angle: verdict.angle, when });
  }

  return (
    <View accessible accessibilityRole="header" style={styles.row}>
      <AscentStatusMark status={verdict.kind} size={MARK_SIZE} />
      <Text variant="headline" style={styles.headline}>
        {headline}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  untriedMark: {
    width: MARK_SIZE,
    height: MARK_SIZE,
    borderRadius: MARK_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headline: {
    flex: 1,
  },
});
