import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardClimbRecentSender, BoardPresenceClimb } from '@boardsesh/shared-schema';
import { Text } from '../../Text';
import { AvatarGroup } from '../../you/AvatarGroup';
import { BoardDriverAvatar } from '../BoardDriverAvatar';
import { readableTextColor } from '../../grade/grade-chip-colors';
import { useTheme } from '../../../providers/theme-provider';
import { useDisplayGrade } from '../../../hooks/use-display-grade';
import { borderRadius, spacing } from '../../../theme/tokens';
import type { WallKioskTypeScale } from './wall-kiosk-type';

type WallIdentityBlockProps = {
  climb: BoardPresenceClimb | null;
  typeScale: WallKioskTypeScale;
  isPreviewing: boolean;
  recentSenders: BoardClimbRecentSender[];
  /** Bands can move the paired attribution rows into a sibling column so the
   *  extra row does not make the board region smaller. */
  showAttribution?: boolean;
  /** Very wide, shallow bands move the setter into the attribution column. */
  showSetter?: boolean;
  /** A three-column band uses a fitted single-line name to stay inside the
   *  dominance-capped chrome height. */
  nameLines?: 1 | 2;
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
  recentSenders,
  showAttribution = true,
  showSetter = true,
  nameLines = 2,
  driverSize = 32,
  compact = false,
}: WallIdentityBlockProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { resolveGrade } = useDisplayGrade();

  if (!climb) return null;

  const name = climb.name?.trim() || '';
  // BoardPresenceClimb carries no Boardsesh grade today, so `resolveGrade` falls
  // back to the legacy label + colour — the kiosk lights up the Boardsesh grade
  // once the backend stamps presence climbs.
  const resolvedGrade = resolveGrade({ difficulty: climb.grade ?? '' });
  const grade = climb.grade ? resolvedGrade.label : null;
  const gradeColor = resolvedGrade.color;
  const gradeTextColor = readableTextColor(gradeColor);
  const setter = climb.setter?.trim();
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
        numberOfLines={nameLines}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
        color={systemColors.label}
        style={[styles.name, { fontSize: typeScale.nameFontSize, lineHeight: typeScale.nameLineHeight }]}
      >
        {name}
      </Text>

      {setter && showSetter && !compact ? (
        <Text
          numberOfLines={1}
          color={systemColors.secondaryLabel}
          style={{ fontSize: typeScale.metaFontSize, lineHeight: typeScale.metaLineHeight }}
        >
          {t('mobile.boardPresence.setByLine', { setter })}
        </Text>
      ) : null}

      {showAttribution ? (
        <WallAttributionBlock
          climb={climb}
          typeScale={typeScale}
          recentSenders={recentSenders}
          driverSize={driverSize}
          compact={compact}
        />
      ) : null}
    </View>
  );
}

export const WallIdentityBlock = memo(WallIdentityBlockComponent);

type WallAttributionBlockProps = {
  climb: BoardPresenceClimb | null;
  typeScale: WallKioskTypeScale;
  recentSenders: BoardClimbRecentSender[];
  driverSize?: number;
  compact?: boolean;
};

/** The paired wall bylines. Keep them in one component so every placement
 * preserves the required Lit-by → Sent-by vertical order. */
function WallAttributionBlockComponent({
  climb,
  typeScale,
  recentSenders,
  driverSize = 32,
  compact = false,
}: WallAttributionBlockProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const litBy = climb?.sentByDisplayName?.trim() || null;

  if (!climb || compact || (!litBy && recentSenders.length === 0)) return null;

  return (
    <View style={styles.attributionRoot}>
      {litBy ? (
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
            {t('boardPresence.litByLine', { name: litBy })}
          </Text>
        </View>
      ) : null}

      {recentSenders.length > 0 ? (
        <View style={styles.senderRow}>
          <Text
            numberOfLines={1}
            color={systemColors.secondaryLabel}
            style={{ fontSize: typeScale.metaFontSize, lineHeight: typeScale.metaLineHeight }}
          >
            {t('boardPresence.sentByLabel')}
          </Text>
          <AvatarGroup participants={recentSenders} size={driverSize} max={5} />
        </View>
      ) : null}
    </View>
  );
}

export const WallAttributionBlock = memo(WallAttributionBlockComponent);

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
  attributionRoot: {
    gap: spacing[2],
  },
  senderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingTop: 2,
  },
});
