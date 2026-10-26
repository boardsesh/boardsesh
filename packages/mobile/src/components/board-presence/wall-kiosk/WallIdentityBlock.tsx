import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { readableTextColor } from '../../grade/grade-chip-colors';
import { useTheme } from '../../../providers/theme-provider';
import { useDisplayGrade } from '../../../hooks/use-display-grade';
import { borderRadius, spacing } from '../../../theme/tokens';
import type { WallKioskTypeScale } from './wall-kiosk-type';

type WallIdentityBlockProps = {
  climb: BoardPresenceClimb | null;
  typeScale: WallKioskTypeScale;
  isPreviewing: boolean;
  /** A three-column band uses a fitted single-line name to stay inside the
   *  dominance-capped chrome height. */
  nameLines?: 1 | 2;
  /** The kiosk's board, so the grade reads on its scale (the wall payload names no board). */
  boardName?: string;
};

/**
 * The climb identity — all OFF the board, on the opaque chrome surface: the
 * GRADE above the NAME, and nothing else. The kiosk is read from 3–5 m, where
 * only these two carry; the setter byline, the angle badge and the Lit-by /
 * Sent-by avatars were 13–24 pt and unreadable from the mat, so they are not
 * drawn here. The grade is a SOLID `getGradeColor` fill chip with contrast-picked
 * on-color text (`readableTextColor`) — not colored foreground text, which is
 * invisible for the yellow/green bands on a light surface. In preview a
 * "PREVIEW" tag rides the grade row for whoever is scrubbing at arm's length,
 * so the loudest lockup can't be mistaken for what's live.
 */
function WallIdentityBlockComponent({
  climb,
  typeScale,
  isPreviewing,
  nameLines = 2,
  boardName,
}: WallIdentityBlockProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { resolveGrade } = useDisplayGrade();

  if (!climb) return null;

  const name = climb.name?.trim() || '';
  // BoardPresenceClimb carries no Boardsesh grade today, so `resolveGrade` falls
  // back to the legacy label + colour — the kiosk lights up the Boardsesh grade
  // once the backend stamps presence climbs.
  const resolvedGrade = resolveGrade({ difficulty: climb.grade ?? '' }, boardName);
  const grade = climb.grade ? resolvedGrade.label : null;
  const gradeColor = resolvedGrade.color;
  const gradeTextColor = readableTextColor(gradeColor);

  return (
    <View style={styles.root}>
      <View style={styles.gradeRow}>
        {isPreviewing ? (
          <View style={[styles.previewTag, { backgroundColor: brandColors.historyFill }]}>
            <Text variant="caption2" color="#FFFFFF" style={styles.previewTagText}>
              {t('mobile.boardPresence.kiosk.previewTag')}
            </Text>
          </View>
        ) : null}
        {grade ? (
          <View style={[styles.gradeChip, { backgroundColor: gradeColor }]}>
            <Text
              allowFontScaling={false}
              numberOfLines={1}
              style={[
                styles.grade,
                { color: gradeTextColor, fontSize: typeScale.gradeFontSize, lineHeight: typeScale.gradeLineHeight },
              ]}
            >
              {grade}
            </Text>
          </View>
        ) : null}
      </View>

      <Text
        allowFontScaling={false}
        numberOfLines={nameLines}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
        color={systemColors.label}
        style={[styles.name, { fontSize: typeScale.nameFontSize, lineHeight: typeScale.nameLineHeight }]}
      >
        {name}
      </Text>
    </View>
  );
}

export const WallIdentityBlock = memo(WallIdentityBlockComponent);

const styles = StyleSheet.create({
  root: { gap: spacing[2] },
  gradeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  previewTag: {
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
  },
  previewTagText: {
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  gradeChip: {
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grade: {
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  name: {
    fontWeight: '800',
  },
});
