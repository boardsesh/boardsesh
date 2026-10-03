import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { parseTickTime, type ClimbVerdict } from '@boardsesh/profile-stats';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { formatLedgerDate } from './day-label';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';

const GLYPH_SIZE = 16;

type LogbookHeadlineProps = {
  /** A send or a flash. Picks the glyph only: the words carry the result. */
  sent: boolean;
  text: string;
};

/**
 * The Logbook card's headline line: one small glyph and the words. The glyph is
 * decoration (a green tick for a send, a grey dash otherwise), so the text is
 * the whole accessibility label.
 */
export const LogbookHeadline = memo(function LogbookHeadline({ sent, text }: LogbookHeadlineProps) {
  const { brandColors, systemColors } = useTheme();
  return (
    <View accessible accessibilityRole="header" accessibilityLabel={text} style={styles.row}>
      {sent ? (
        <Icon name="check.small" size={GLYPH_SIZE} color={brandColors.success} />
      ) : (
        <Icon name="minus" size={GLYPH_SIZE} color={systemColors.secondaryLabel} />
      )}
      <Text variant="headline" style={styles.headline}>
        {text}
      </Text>
    </View>
  );
});

type LogbookVerdictProps = {
  verdict: ClimbVerdict;
  todayKey: string;
  yesterdayKey: string;
};

/** Where the climber stands on this climb, in one line. */
export const LogbookVerdict = memo(function LogbookVerdict({ verdict, todayKey, yesterdayKey }: LogbookVerdictProps) {
  const { t } = useTranslation('session');

  if (verdict.kind === 'untried') {
    return <LogbookHeadline sent={false} text={t('mobile.logbook.noEntries')} />;
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

  return <LogbookHeadline sent={verdict.kind !== 'attempt'} text={headline} />;
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  headline: {
    flex: 1,
  },
});
