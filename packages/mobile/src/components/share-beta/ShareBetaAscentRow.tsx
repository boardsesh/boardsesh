import { memo, useCallback, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { deriveLogbookGradeDisplay, displayedAttemptCount } from '@boardsesh/logbook';
import { formatTickRelativeTime, getLayoutDisplayName } from '@boardsesh/profile-stats';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { useBoardseshGradesActive } from '../../hooks/use-display-grade';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { GRADE_BY_ID, clampDifficultyId, resolveCrowdDifficultyId } from '../../lib/boardsesh-grade-display';
import { getBoardConfigForPlaylist } from '../../lib/playlists/board-details-for-playlist';
import { hapticSelection } from '../../lib/haptics';
import { borderRadius, spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

const THUMBNAIL_SIZE = { width: 48, height: 48 } as const;

type ShareBetaAscentRowProps = {
  ascent: AscentFeedItem;
  onActivate: (ascent: AscentFeedItem) => void;
};

/** Picker-specific ascent row: recognition-first board art without logbook gestures or diary controls. */
export const ShareBetaAscentRow = memo(function ShareBetaAscentRow({ ascent, onActivate }: ShareBetaAscentRowProps) {
  const { t } = useTranslation(['session', 'you']);
  const { systemColors } = useTheme();
  const { formatGrade, formatGradeByDifficultyId } = useGradeFormat();
  const boardseshActive = useBoardseshGradesActive();

  const crowdDifficulty = resolveCrowdDifficultyId(ascent, boardseshActive);
  const { gradeIsConsensus } = deriveLogbookGradeDisplay(ascent.difficulty, crowdDifficulty);
  const rawGradeLabel = ascent.difficultyName ?? ascent.consensusDifficultyName;
  const displayedDifficulty = ascent.difficulty ?? crowdDifficulty;
  const gradeLabel =
    formatGradeByDifficultyId(displayedDifficulty) ?? formatGrade(rawGradeLabel) ?? rawGradeLabel ?? null;
  const gradeColorName =
    gradeIsConsensus && crowdDifficulty != null
      ? (GRADE_BY_ID.get(clampDifficultyId(crowdDifficulty))?.difficulty_name ?? rawGradeLabel)
      : rawGradeLabel;
  const gradeColor = gradeColorName ? (getGradeColor(gradeColorName) ?? DEFAULT_GRADE_COLOR) : DEFAULT_GRADE_COLOR;

  const tries = displayedAttemptCount(ascent.attemptCount);
  const resultLabel =
    ascent.status === 'flash'
      ? t('you:mobile.logbook.status.flash')
      : ascent.status === 'send'
        ? `${t('you:mobile.logbook.status.send')} · ${t('you:mobile.logbook.tries', { count: tries })}`
        : `${t('you:mobile.logbook.row.project')} · ${t('you:mobile.logbook.tries', { count: tries })}`;
  const wallLabel = ascent.boardDisplayName ?? getLayoutDisplayName(ascent.boardType, ascent.layoutId);
  const wallAngleLabel = `${wallLabel} ${ascent.angle}°`;
  const relativeTime = formatTickRelativeTime(ascent.climbedAt);
  const mirrorLabel = ascent.isMirror ? t('you:mobile.logbook.row.a11yMirrored') : null;

  // Requiring an explicit layout prevents getBoardConfigForPlaylist's generic
  // default from drawing the wrong wall behind older, incomplete ticks.
  const boardConfig =
    ascent.frames && ascent.layoutId != null ? getBoardConfigForPlaylist(ascent.boardType, ascent.layoutId) : null;

  const accessibilityDetails = [
    ascent.climbName,
    mirrorLabel,
    gradeLabel
      ? gradeIsConsensus
        ? t('you:mobile.logbook.row.a11yCommunityGrade', { grade: gradeLabel })
        : gradeLabel
      : null,
    resultLabel,
    wallAngleLabel,
    relativeTime,
  ]
    .filter((part): part is string => !!part)
    .join(', ');
  const accessibilityLabel = t('mobile.betaVideos.shareAscentLabel', { details: accessibilityDetails });

  // FlashList can recycle this component onto another ascent. Read both the
  // current item and current host callback from refs so one stable press handler
  // never attaches beta to the row that used to occupy this cell.
  const ascentRef = useRef(ascent);
  ascentRef.current = ascent;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const handlePress = useCallback(() => {
    hapticSelection();
    onActivateRef.current(ascentRef.current);
  }, []);

  return (
    <View style={styles.container}>
      <PressableSurface
        onPress={handlePress}
        feedback="opacity"
        opacityTo={0.7}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={[styles.row, { backgroundColor: systemColors.secondaryBackground }]}
      >
        <View
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.thumbnailSlot}
        >
          {boardConfig && ascent.frames ? (
            <ClimbListThumbnail
              frames={ascent.frames}
              boardName={boardConfig.boardName}
              layoutId={boardConfig.layoutId}
              sizeId={boardConfig.sizeId}
              setIds={boardConfig.setIds.join(',')}
              mirrored={ascent.isMirror}
              size={THUMBNAIL_SIZE}
            />
          ) : (
            <View style={[styles.thumbnailFallback, { backgroundColor: systemColors.fill }]}>
              <Icon name="lightbulb" size={20} color={systemColors.tertiaryLabel} />
            </View>
          )}
        </View>

        <View style={styles.details}>
          <View style={styles.nameRow}>
            <Text variant="body" numberOfLines={2} style={styles.climbName}>
              {ascent.climbName}
            </Text>
            {ascent.isMirror ? <Icon name="mirror" size={12} color={systemColors.secondaryLabel} /> : null}
          </View>
          <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
            {resultLabel}
          </Text>
          <Text variant="caption1" color={systemColors.tertiaryLabel} numberOfLines={1}>
            {wallAngleLabel} · {relativeTime}
          </Text>
        </View>

        {gradeLabel ? (
          <View style={styles.gradeColumn}>
            {gradeIsConsensus ? <Icon name="people" size={13} color={systemColors.secondaryLabel} /> : null}
            <Text variant="title3" numberOfLines={1} style={[styles.grade, { color: gradeColor }]}>
              {gradeLabel}
            </Text>
          </View>
        ) : null}
      </PressableSurface>
      <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  row: {
    minHeight: 64,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  thumbnailSlot: {
    width: THUMBNAIL_SIZE.width,
    height: THUMBNAIL_SIZE.height,
    flexShrink: 0,
  },
  thumbnailFallback: {
    width: THUMBNAIL_SIZE.width,
    height: THUMBNAIL_SIZE.height,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  details: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  nameRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  climbName: {
    flexShrink: 1,
    fontWeight: '600',
  },
  gradeColumn: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    marginLeft: spacing[1],
  },
  grade: {
    fontWeight: '700',
    textAlign: 'right',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing[4] + THUMBNAIL_SIZE.width + spacing[3],
  },
});
