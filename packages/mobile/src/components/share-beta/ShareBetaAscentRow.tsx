import { memo, useCallback, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import {
  deriveGradeTokenModel,
  displayedAttemptCount,
  gradeTokenA11yLabel,
  logbookAttemptsKind,
} from '@boardsesh/logbook';
import { formatTickRelativeTime, getLayoutDisplayName } from '@boardsesh/profile-stats';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { ClimbAttributeIcons } from '../ClimbAttributeIcons';
import { Icon } from '../Icon';
import { GradeValue } from '../grade/GradeValue';
import { type IconName } from '../icon-map';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { useBoardseshGradesActive } from '../../hooks/use-display-grade';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { GRADE_BY_ID, clampDifficultyId, resolveCrowdDifficultyId } from '../../lib/boardsesh-grade-display';
import { renderBoardToPlaylistConfig } from '../../lib/playlists/board-details-for-playlist';
import { hapticSelection } from '../../lib/haptics';
import type { ShareBetaAscentSource } from '../../lib/share-beta-list';
import { iosSystemColors } from '../../theme/ios-colors';
import { borderRadius, spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

/**
 * Portrait board-art cell for the picker — narrower than the 76×96 climbs-list
 * cell so a recognition list still fits several ascents on screen, same 0.79
 * aspect so the portrait board fills it instead of letterboxing.
 *
 * KEEP THE WIDTH ≤ 80. ClimbListThumbnail renders at
 * `Math.max(400, width * 5)`, and that number is part of the render cache key
 * (`..._w400_...`). At any width up to 80 this resolves to exactly 400 — the
 * same key the climbs list and the play view already wrote — so a climb the
 * climber has seen anywhere in the app paints straight from the disk PNG cache
 * with zero render work. Bumping this to 84 would silently double the cache.
 */
const THUMBNAIL_SIZE = { width: 60, height: 76 } as const;

/** Small result glyph — the picker's thumbnail owns the leading slot, so status rides the meta line. */
const STATUS_ICON: Record<AscentFeedItem['status'], IconName> = {
  flash: 'flash',
  send: 'tick.outline',
  attempt: 'circle',
};

type ShareBetaAscentRowProps = {
  ascent: AscentFeedItem;
  source: ShareBetaAscentSource;
  onActivate: (ascent: AscentFeedItem, source: ShareBetaAscentSource) => void;
};

/**
 * Picker row for the share-beta screen: board art first, then just enough of the
 * log entry to tell two similar sends apart. Deliberately NOT `LogbookRow` —
 * #3350 dropped the thumbnail from the diary row on purpose (the logbook and the
 * climbs catalog rhymed and climbers lost track of which list they were on), and
 * this row exists so the picker can have the art back without putting it back
 * there. It is a selector, so it carries no swipe, long-press, or edit/delete
 * accessibility actions.
 */
export const ShareBetaAscentRow = memo(function ShareBetaAscentRow({
  ascent,
  source,
  onActivate,
}: ShareBetaAscentRowProps) {
  const { t } = useTranslation(['session', 'you']);
  const { systemColors, brandColors } = useTheme();
  const { formatGrade, formatGradeByDifficultyId } = useGradeFormat();
  const boardseshActive = useBoardseshGradesActive();

  // Grade slot mirrors LogbookRow: ONE number, and a `people` marker only when
  // that number is the crowd's. A diary surface — the picker lists YOUR ascents
  // — so your own grade is the unremarkable one here. The crowd's number, when
  // it differs, leads the result line below instead of stacking under this one.
  const crowdDifficulty = resolveCrowdDifficultyId(ascent, boardseshActive);
  const rawGradeLabel = ascent.difficultyName ?? ascent.consensusDifficultyName;
  const personalGradeLabel =
    ascent.difficulty != null
      ? (formatGradeByDifficultyId(ascent.difficulty) ?? formatGrade(ascent.difficultyName) ?? ascent.difficultyName)
      : null;
  const crowdGradeLabel =
    crowdDifficulty != null
      ? (formatGradeByDifficultyId(crowdDifficulty) ??
        formatGrade(ascent.consensusDifficultyName) ??
        ascent.consensusDifficultyName)
      : null;
  const gradeModel = deriveGradeTokenModel({
    personalLabel: personalGradeLabel,
    crowdLabel: crowdGradeLabel,
    baseline: 'personal',
  });
  const gradeColorName =
    gradeModel.source === 'crowd' && crowdDifficulty != null
      ? (GRADE_BY_ID.get(clampDifficultyId(crowdDifficulty))?.difficulty_name ?? rawGradeLabel)
      : rawGradeLabel;
  const gradeColor = gradeColorName ? (getGradeColor(gradeColorName) ?? DEFAULT_GRADE_COLOR) : DEFAULT_GRADE_COLOR;

  // Result line reuses the logbook's own wording so the picker and the diary
  // agree — no new visible strings, no new translations to drift.
  const attemptsKind = logbookAttemptsKind(ascent.status);
  const tries = displayedAttemptCount(ascent.attemptCount);
  const attemptsLabel =
    attemptsKind === 'flash'
      ? t('you:mobile.logbook.status.flash')
      : attemptsKind === 'send'
        ? t('you:mobile.logbook.tries', { count: tries })
        : `${t('you:mobile.logbook.row.project')} · ${t('you:mobile.logbook.tries', { count: tries })}`;
  // The crowd's grade leads the result run when it is not the number in the
  // grade slot — grey, uncoloured, one more fact about the climb.
  const resultLabel = [gradeModel.crowdLineToken, attemptsLabel].filter(Boolean).join(' · ');
  const statusColor =
    ascent.status === 'flash'
      ? brandColors.warning
      : ascent.status === 'send'
        ? brandColors.success
        : iosSystemColors.systemGray;

  const wallLabel = ascent.boardDisplayName ?? getLayoutDisplayName(ascent.boardType, ascent.layoutId);
  const wallAngleLabel = `${wallLabel} ${ascent.angle}°`;
  const relativeTime = formatTickRelativeTime(ascent.climbedAt);
  const hasBetaVideo = ascent.hasBetaVideo === true;

  // Draw the climb on the board it was actually logged on. `renderBoard` is what
  // the backend resolved for this tick; falling straight to the layout default
  // (getBoardConfigForPlaylist) would draw every ascent of a climber with a
  // 10x12 home wall on a 12x14 — the bug fixed in #4221. Memoised by board key,
  // so this stays O(1) per row.
  const boardConfig = ascent.frames
    ? renderBoardToPlaylistConfig(ascent.boardType, ascent.layoutId, ascent.renderBoard)
    : null;

  // One a11y element per row: the thumbnail subtree is hidden below, so VoiceOver
  // reads this composed sentence and nothing else.
  // `gradeTokenA11yLabel` resolves its keys out of @boardsesh/logbook, which the
  // i18n orphan checker does not scan — so name them here:
  // i18n-keep common.mobile.gradeToken.a11yYours
  // i18n-keep common.mobile.gradeToken.a11yCommunity
  const gradeA11yLabel = gradeTokenA11yLabel(gradeModel, t);
  const accessibilityDetails = [
    ascent.climbName,
    ascent.isMirror ? t('you:mobile.logbook.row.a11yMirrored') : null,
    gradeA11yLabel,
    gradeModel.crowdLineToken
      ? t('you:mobile.logbook.row.a11yCommunityGrade', { grade: gradeModel.crowdLineToken })
      : null,
    attemptsLabel,
    hasBetaVideo ? t('you:mobile.logbook.row.a11yHasBetaVideo') : null,
    wallAngleLabel,
    relativeTime,
  ]
    .filter((part): part is string => !!part)
    .join(', ');
  const accessibilityLabel = t('session:mobile.betaVideos.shareAscentLabel', { details: accessibilityDetails });

  // FlashList recycles this component onto another ascent. Read the ascent, the
  // section and the host callback from refs so one dep-free press handler can
  // never attach the beta to whichever tick used to occupy this cell.
  const ascentRef = useRef(ascent);
  ascentRef.current = ascent;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const handlePress = useCallback(() => {
    hapticSelection();
    onActivateRef.current(ascentRef.current, sourceRef.current);
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
              // CSS flip only — one cached PNG serves both orientations.
              mirrored={ascent.isMirror}
              size={THUMBNAIL_SIZE}
            />
          ) : (
            // Frameless ticks (MoonBoard pulls) have nothing to draw.
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
            <ClimbAttributeIcons
              benchmarkDifficulty={
                ascent.isBenchmark ? (ascent.consensusDifficultyName ?? ascent.difficultyName ?? '1') : null
              }
              isNoMatch={ascent.isNoMatch}
            />
            {ascent.isMirror ? (
              <View style={styles.mirrorIcon}>
                <Icon name="mirror" size={12} color={systemColors.secondaryLabel} />
              </View>
            ) : null}
          </View>
          <View style={styles.resultRow}>
            <Icon name={STATUS_ICON[ascent.status]} size={13} color={statusColor} />
            <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.resultText}>
              {resultLabel}
            </Text>
          </View>
          <Text variant="caption1" color={systemColors.tertiaryLabel} numberOfLines={1}>
            {`${wallAngleLabel} · ${relativeTime}`}
          </Text>
        </View>

        {/* ONE number, one line — the crowd's, when it differs, is the leading
            token of the result line to the left. */}
        {gradeModel.source !== 'none' || hasBetaVideo ? (
          <View style={styles.gradeColumn}>
            {hasBetaVideo ? <Icon name="video.fill" size={13} color={brandColors.primary} /> : null}
            {gradeModel.source !== 'none' ? (
              <GradeValue
                label={gradeModel.label}
                color={gradeColor}
                source={gradeModel.source}
                baseline="personal"
                accessibilityLabel={gradeA11yLabel ?? undefined}
              />
            ) : null}
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
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing[3],
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
    gap: 2,
  },
  nameRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  climbName: {
    flexShrink: 1,
    fontWeight: '600',
  },
  mirrorIcon: {
    marginLeft: 4,
    flexShrink: 0,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: 4,
    minWidth: 0,
  },
  resultText: {
    flexShrink: 1,
  },
  gradeColumn: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: spacing[1],
    maxWidth: 110,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    // Inset to the text column: row padding + thumbnail + column gap.
    marginLeft: spacing[4] + THUMBNAIL_SIZE.width + spacing[3],
  },
});
