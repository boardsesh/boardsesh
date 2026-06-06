import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { formatSends, formatQuality } from '../../lib/format-climb-stats';
import { Text } from '../Text';
import { DrawerHeader } from '../DrawerHeader';
import { ClimbAttributeIcons } from '../ClimbAttributeIcons';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

const MIN_GRADE_COLUMN_WIDTH: number = spacing[12];
const GRADE_COLUMN_CHARACTER_WIDTH: number = spacing[3];

export function getInitialGradeColumnWidth(displayGrade: string): number {
  return Math.max(MIN_GRADE_COLUMN_WIDTH, displayGrade.length * GRADE_COLUMN_CHARACTER_WIDTH);
}

export function resolvePlayDrawerHeaderGradeColor(displayGrade: string, rawDifficulty?: string): string {
  return getGradeColor(rawDifficulty ?? displayGrade) ?? DEFAULT_GRADE_COLOR;
}

type PlayDrawerHeaderProps = {
  name: string;
  /** Display label (already formatted to V or Font per user preference). */
  difficulty: string;
  /** Raw difficulty (e.g. "6a/V3") used for grade-color lookup. Optional —
   *  falls back to `difficulty` if not provided. */
  rawDifficulty?: string;
  qualityAverage: string;
  ascensionistCount: number;
  setterUsername: string;
  /** Intrinsic attributes shown as grey glyphs after the name. */
  isNoMatch?: boolean | null;
  benchmarkDifficulty?: string | null;
};

export const PlayDrawerHeader = memo(function PlayDrawerHeader({
  name,
  difficulty,
  rawDifficulty,
  qualityAverage,
  ascensionistCount,
  setterUsername,
  isNoMatch,
  benchmarkDifficulty,
}: PlayDrawerHeaderProps) {
  const { t } = useTranslation('climbs');
  const gradeColumnWidth = useMemo(() => getInitialGradeColumnWidth(difficulty), [difficulty]);
  const gradeColor = useMemo(
    () => resolvePlayDrawerHeaderGradeColor(difficulty, rawDifficulty),
    [rawDifficulty, difficulty],
  );

  const subtitleParts: string[] = [];
  if (ascensionistCount > 0) subtitleParts.push(formatSends(ascensionistCount, t));
  const qualityNum = parseFloat(qualityAverage);
  if (qualityNum > 0) subtitleParts.push(`${formatQuality(qualityAverage)}★`);
  if (setterUsername) subtitleParts.push(setterUsername);

  return (
    <DrawerHeader
      center={
        <>
          <View style={styles.nameRow}>
            <Text variant="body" style={styles.nameText} numberOfLines={1}>
              {name}
            </Text>
            <ClimbAttributeIcons isNoMatch={isNoMatch} benchmarkDifficulty={benchmarkDifficulty} />
          </View>
          <Text variant="caption1" style={styles.subtitleText} numberOfLines={1}>
            {subtitleParts.join(' · ')}
          </Text>
        </>
      }
      trailing={
        <Text variant="headline" style={[styles.gradeText, { color: gradeColor }]} numberOfLines={1}>
          {difficulty}
        </Text>
      }
      trailingMinWidth={gradeColumnWidth}
    />
  );
});

const styles = StyleSheet.create({
  gradeText: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    textAlign: 'right',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
  },
  nameText: {
    fontWeight: '700',
    textAlign: 'center',
    // Shrink so a long name truncates while the attribute glyphs stay visible.
    flexShrink: 1,
  },
  subtitleText: {
    color: iosSystemColors.systemGray,
    marginTop: 2,
    textAlign: 'center',
  },
});
