import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { BoardDriverAvatar } from '../BoardDriverAvatar';
import { readableTextColor } from '../../grade/grade-chip-colors';
import { useTheme } from '../../../providers/theme-provider';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { borderRadius, spacing } from '../../../theme/tokens';
import type { WallKioskTypeScale } from './wall-kiosk-type';

type WallIdentityBlockProps = {
  climb: BoardPresenceClimb | null;
  typeScale: WallKioskTypeScale;
  isPreviewing: boolean;
  driverSize?: number;
  /** Extreme aspect ratio starved the chrome → show only grade + name (shed the
   *  lower-priority setter + driver lines) so the controls still fit. */
  compact?: boolean;
};

/**
 * The climb identity — all OFF the board, on the opaque chrome surface. Hierarchy
 * GRADE > NAME > meta. The grade is a SOLID `getGradeColor` fill chip with
 * contrast-picked on-color text (`readableTextColor`) — not colored foreground
 * text, which is invisible for the yellow/green bands on a light surface. In
 * preview a "PREVIEW" tag rides the grade row so the loudest lockup can't be
 * mistaken for what's live.
 */
function WallIdentityBlockComponent({
  climb,
  typeScale,
  isPreviewing,
  driverSize = 32,
  compact = false,
}: WallIdentityBlockProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { formatGrade } = useGradeFormat();

  if (!climb) return null;

  const name = climb.name?.trim() || '';
  const grade = climb.grade ? formatGrade(climb.grade) : null;
  const gradeColor = getGradeColor(climb.grade ?? '') ?? DEFAULT_GRADE_COLOR;
  const gradeTextColor = readableTextColor(gradeColor);
  const setter = climb.setter?.trim();
  const litBy = climb.sentByDisplayName?.trim() || null;
  const angleLabel = climb.angle != null ? `${climb.angle}°` : null;

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
        {angleLabel ? (
          <View style={[styles.anglePill, { backgroundColor: systemColors.fill }]}>
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.angleText}>
              {angleLabel}
            </Text>
          </View>
        ) : null}
      </View>

      <Text
        allowFontScaling={false}
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
        color={systemColors.label}
        style={[styles.name, { fontSize: typeScale.nameFontSize, lineHeight: typeScale.nameLineHeight }]}
      >
        {name}
      </Text>

      {setter && !compact ? (
        <Text
          numberOfLines={1}
          color={systemColors.secondaryLabel}
          style={{ fontSize: typeScale.metaFontSize, lineHeight: typeScale.metaLineHeight }}
        >
          {t('mobile.boardPresence.setByLine', { setter })}
        </Text>
      ) : null}

      {litBy && !compact ? (
        <View style={styles.driverRow}>
          <BoardDriverAvatar
            size={driverSize}
            userId={climb.sentByUserId}
            uri={climb.sentByAvatarUrl}
            name={litBy}
            status="connected"
            accessibilityLabel={t('mobile.boardPresence.drivenByA11y', { name: litBy })}
          />
          <Text
            numberOfLines={1}
            color={systemColors.secondaryLabel}
            style={[styles.driverName, { fontSize: typeScale.metaFontSize, lineHeight: typeScale.metaLineHeight }]}
          >
            {t('mobile.boardPresence.sentByLine', { name: litBy })}
          </Text>
        </View>
      ) : null}
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
  anglePill: {
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing[2],
    paddingVertical: 3,
  },
  angleText: {
    fontWeight: '600',
  },
  name: {
    fontWeight: '800',
  },
  driverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingTop: 2,
  },
  driverName: {
    flexShrink: 1,
  },
});
