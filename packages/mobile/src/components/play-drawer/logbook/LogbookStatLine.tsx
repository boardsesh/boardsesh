import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { LedgerAngleSection, LedgerTotals } from '@boardsesh/profile-stats';
import { Text } from '../../Text';
import { formatAngleResult } from './angle-result';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { useTheme } from '../../../providers/theme-provider';

type LogbookStatLineProps = {
  totals: LedgerTotals;
  /**
   * The one angle `totals` describes: the board's angle when it has logs, or
   * the only angle the climber has logged. Undefined when the totals span
   * several angles, and the line then says so instead of naming a result.
   */
  section: LedgerAngleSection<unknown> | undefined;
};

/**
 * The one line under the verdict, e.g. "Flashed · 4 tries, 2 sends over 1
 * session". The sends count is left out at zero, and the climber's own grade
 * joins only when they gave one.
 */
export const LogbookStatLine = memo(function LogbookStatLine({ totals, section }: LogbookStatLineProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { formatGradeByDifficultyId } = useGradeFormat();

  // Segments pluralize individually; the TEMPLATES own word order and joining
  // so a locale can rearrange the clauses.
  const tries = t('mobile.logbook.lifetimeTries', { count: totals.tries });
  const sessions = t('mobile.logbook.lifetimeSessions', { count: totals.sessions });
  const recap =
    totals.sends > 0
      ? t('mobile.logbook.statRecap', {
          tries,
          sends: t('mobile.logbook.sendCount', { count: totals.sends }),
          sessions,
        })
      : t('mobile.logbook.lifetimeRecap', { tries, sessions });

  let line = section
    ? t('mobile.logbook.angleLine', { result: formatAngleResult(t, section), recap })
    : t('mobile.logbook.statLineAllAngles', { recap });
  const grade = formatGradeByDifficultyId(totals.personalGrade);
  if (grade) line = t('mobile.logbook.statLineWithGrade', { line, grade });

  return (
    <Text variant="subheadline" color={systemColors.secondaryLabel}>
      {line}
    </Text>
  );
});
