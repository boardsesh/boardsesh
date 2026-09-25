import { memo, useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { CLIMB_CHARACTERISTICS, type BoardName, type Climb } from '@boardsesh/shared-schema';
import { useEffectiveClimbStats } from '@boardsesh/board-react';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { formatSends, formatQuality } from '../../lib/format-climb-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { MarqueeText } from '../MarqueeText';
import { DrawerHeader } from '../DrawerHeader';
import { ClimbAttributeIcons } from '../ClimbAttributeIcons';
import { iosSystemColors } from '../../theme/ios-colors';
import { WALL_STATE_PILL_TOUCH_HEIGHT } from '../../theme/layout';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { resolveClimbRuleLabels } from './climb-rule-labels';

type PlayDrawerHeaderProps = {
  name: string;
  /** Display label (already formatted to V or Font per user preference). */
  difficulty: string;
  /** Raw difficulty (e.g. "6a/V3") used for grade-color lookup. Optional —
   *  falls back to `difficulty` if not provided. */
  rawDifficulty?: string | null;
  /** Explicit grade colour, overriding the internal `getGradeColor` lookup. The
   *  play drawer passes this so the colour matches the shown grade when the "Show
   *  Boardsesh grades" toggle swaps the label to the Boardsesh grade. Falls back
   *  to `getGradeColor(rawDifficulty ?? difficulty)` when omitted. */
  gradeColor?: string;
  qualityAverage: string | null;
  ascensionistCount: number;
  setterUsername: string;
  /** Intrinsic attributes shown as grey glyphs after the name. */
  benchmarkDifficulty?: string | null;
  /** Climb characteristics; no-match and MoonBoard method_* tokens render as glyphs/labels. */
  characteristics?: string[] | null;
  /** Fallback no-match flag for a climb that carries the bool but no characteristics
   *  array (tick- and notification-sourced rows). Ignored when the rules line states
   *  matching in full, so the two never say it twice. */
  isNoMatch?: boolean | null;
  /** The board being played. Boards whose `explicitClimbRules` capability is on
   *  (Woods) print both climb rules under the subtitle; everything else keeps the
   *  exception-only glyph cluster beside the name. */
  boardName?: BoardName;
  /** The community voted this climb out of the browse lists. Prints a caption under
   *  the subtitle so someone who reached it by link, queue or deep link knows why
   *  it stopped showing up in search. */
  isHidden?: boolean;
  /** Left-aligned element on the name's row (e.g. the on-wall status). The header
   *  balances both flanks so the name stays centered. The swipe peek passes a
   *  reserve-only copy so the incoming header matches this one exactly. */
  leading?: ReactNode;
  /** Long-press handler on the name (copies it to the clipboard). When omitted the
   *  name is a plain, non-interactive label — used for the swipe "peek" header. */
  onLongPressName?: () => void;
  onPressSetter?: () => void;
  /** The angle the grade and send count above (the `difficulty`/`qualityAverage`/
   *  `ascensionistCount` props) were read from. Present only when the climb was
   *  pulled in from another angle (issue #5405/#5532's "Other angles" toggle);
   *  `undefined`/`null` means the numbers match `angle` and no marker is shown. */
  statsAngle?: number | null;
  /** The angle currently being viewed. Compared against `statsAngle` to decide
   *  whether to show the "set at N°" marker under the grade. */
  angle?: number;
};

export const PlayDrawerHeader = memo(function PlayDrawerHeader({
  name,
  difficulty,
  rawDifficulty,
  gradeColor,
  qualityAverage,
  ascensionistCount,
  setterUsername,
  benchmarkDifficulty,
  characteristics,
  isNoMatch,
  boardName,
  isHidden = false,
  leading,
  onLongPressName,
  onPressSetter,
  statsAngle,
  angle,
}: PlayDrawerHeaderProps) {
  const { t } = useTranslation('climbs');
  const resolvedGradeColor = useMemo(
    () => gradeColor ?? getGradeColor(rawDifficulty ?? difficulty) ?? DEFAULT_GRADE_COLOR,
    [gradeColor, rawDifficulty, difficulty],
  );
  // Same marker, same key and styling as the search-list row (ClimbListItemContent):
  // this climb's grade/sends came from a different angle than the one on the wall.
  // It shares the row's narrow lag too: `statsAngle` is fixed at fetch time, so after
  // the first ever tick at the browsed angle the marker keeps naming the old angle
  // until the climb is refetched. Self-correcting; see the row's comment.
  const showSetAngleMarker = statsAngle != null && statsAngle !== angle;

  const subtitleParts: string[] = [];
  if (ascensionistCount > 0) subtitleParts.push(formatSends(ascensionistCount, t));
  const qualityNum = qualityAverage == null ? Number.NaN : parseFloat(qualityAverage);
  if (qualityAverage != null && qualityNum > 0) subtitleParts.push(`${formatQuality(qualityAverage)}★`);
  if (setterUsername && !onPressSetter) subtitleParts.push(setterUsername);

  // Woods states both rules on every problem, so we do too — see the
  // `explicitClimbRules` capability. Recomputed per climb, which is also what
  // makes the swipe peek show the INCOMING climb's rules: both headers are this
  // component with their own climb's characteristics.
  const ruleLabels = getBoardCapabilities(boardName).explicitClimbRules
    ? resolveClimbRuleLabels(characteristics, t)
    : null;

  const residualCharacteristics = ruleLabels
    ? characteristics?.filter(
        (token) =>
          token !== CLIMB_CHARACTERISTICS.NO_MATCH &&
          token !== CLIMB_CHARACTERISTICS.ANY_FEET &&
          token !== CLIMB_CHARACTERISTICS.CAMPUS,
      )
    : characteristics;

  return (
    <DrawerHeader
      leading={leading}
      // Reserve the wall-state pill's 44pt touch box unconditionally. The pill
      // comes and goes with the wall (and the swipe peek carries only an
      // invisible copy), so without a floor the header would breathe 64↔68pt on
      // every change — visibly stepping the name and its attribute glyphs, and
      // resizing the board art below inside the fixed-height first screen.
      minRowHeight={WALL_STATE_PILL_TOUCH_HEIGHT}
      center={
        <>
          <View style={styles.nameRow}>
            {/* Long-press copies the name; the name itself is a single-line marquee
                that scrolls when it overflows, so the header height — and the board
                below it — stays constant per climb. Under Reduce Motion it falls
                back to a 2-line wrap (full name). */}
            <Pressable
              onLongPress={onLongPressName}
              disabled={!onLongPressName}
              delayLongPress={350}
              accessibilityRole={onLongPressName ? 'button' : undefined}
              accessibilityHint={onLongPressName ? t('mobile.climbActions.copyNameHint') : undefined}
              style={styles.namePressable}
            >
              <MarqueeText active variant="body" style={styles.nameClip} textStyle={styles.nameText} fallbackLines={2}>
                {name}
              </MarqueeText>
            </Pressable>
            {/* Keep rules the matching/feet line does not state, including no kickboard. */}
            <ClimbAttributeIcons
              benchmarkDifficulty={benchmarkDifficulty}
              characteristics={residualCharacteristics?.length ? residualCharacteristics : null}
              isNoMatch={ruleLabels ? undefined : isNoMatch}
            />
          </View>
          <Text variant="caption1" style={styles.subtitleText} numberOfLines={1}>
            {subtitleParts.join(' · ')}
            {setterUsername && onPressSetter ? (
              <Text variant="caption1" onPress={onPressSetter} accessibilityRole="link">
                {subtitleParts.length > 0 ? ' · ' : ''}
                {setterUsername}
              </Text>
            ) : null}
          </Text>
          {/* One caption line, same grey as the subtitle: this is context for a
              climb you can still open by link or queue, not an error. */}
          {isHidden ? (
            <View style={styles.hiddenRow} testID="play-drawer-climb-hidden">
              <Icon name="visibility.off" size={14} color={iosSystemColors.systemGray} />
              <Text variant="caption1" style={styles.hiddenText}>
                {t('mobile.hidden.banner')}
              </Text>
            </View>
          ) : null}
          {/* Deliberately unbounded lines: at the largest Dynamic Type sizes, or
              on a narrow phone in German, "Matching allowed · Marked holds only"
              does not fit one line, and a truncated climb RULE is worse than a
              taller header — the header is measured with onLayout, so wrapping
              just moves the board down a row. */}
          {ruleLabels ? (
            <Text
              variant="caption1"
              style={styles.rulesText}
              accessibilityLabel={ruleLabels.accessibilityLabel}
              testID="play-drawer-climb-rules"
            >
              {ruleLabels.parts.join(' · ')}
            </Text>
          ) : null}
        </>
      }
      trailing={
        <View style={styles.gradeColumn}>
          <Text variant="headline" style={[styles.gradeText, { color: resolvedGradeColor }]} numberOfLines={1}>
            {difficulty}
          </Text>
          {showSetAngleMarker ? (
            <Text
              variant="caption2"
              numberOfLines={1}
              accessibilityLabel={t('mobile.climbRow.setAngleMarkerAria', { angle: statsAngle })}
              style={styles.setAngleMarkerText}
            >
              {t('mobile.climbRow.setAngleMarker', { angle: statsAngle })}
            </Text>
          ) : null}
        </View>
      }
    />
  );
});

type LivePlayDrawerHeaderProps = {
  climb: Climb;
  boardName: BoardName;
  layoutId: number;
  angle: number;
  leading?: ReactNode;
  onLongPressName?: () => void;
  onPressSetter?: () => void;
};

/** The only play-header child subscribed to the exact live-stat key. */
export const LivePlayDrawerHeader = memo(function LivePlayDrawerHeader({
  climb,
  boardName,
  layoutId,
  angle,
  leading,
  onLongPressName,
  onPressSetter,
}: LivePlayDrawerHeaderProps) {
  const { resolveGrade } = useDisplayGrade();
  const liveStats = useEffectiveClimbStats(boardName, layoutId, climb.uuid, angle, {
    ascensionistCount: climb.ascensionist_count,
    qualityAverage: climb.quality_average,
    difficulty: climb.difficulty,
  });
  const displayedGrade = resolveGrade({
    ...climb,
    difficulty: liveStats.difficulty,
  });

  return (
    <PlayDrawerHeader
      name={climb.name}
      difficulty={displayedGrade.label}
      rawDifficulty={liveStats.difficulty}
      gradeColor={displayedGrade.color}
      qualityAverage={liveStats.qualityAverage}
      ascensionistCount={liveStats.ascensionistCount}
      setterUsername={climb.setter_username}
      onPressSetter={onPressSetter}
      benchmarkDifficulty={climb.benchmark_difficulty}
      characteristics={climb.characteristics}
      isNoMatch={climb.is_no_match}
      boardName={boardName}
      isHidden={climb.is_hidden === true}
      leading={leading}
      onLongPressName={onLongPressName}
      statsAngle={climb.statsAngle}
      angle={angle}
    />
  );
});

const styles = StyleSheet.create({
  // Wraps the grade + the optional "set at N°" marker so the marker sits right
  // under the grade it qualifies, both right-aligned in the trailing slot.
  gradeColumn: {
    alignItems: 'flex-end',
  },
  // Deliberately uncoloured, same as the search-list row's marker — colour in
  // this slot carries the grade and nothing else.
  setAngleMarkerText: {
    color: iosSystemColors.systemGray,
    textAlign: 'right',
  },
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
  // Shrinks with the name so a long title scrolls within the available width while
  // the attribute glyphs stay visible; the long-press target is the name itself.
  namePressable: {
    flexShrink: 1,
    minWidth: 0,
  },
  // The marquee clip fills the (shrinking) pressable so it's bounded enough to
  // detect overflow and scroll; it hugs its content when the name fits.
  nameClip: {
    alignSelf: 'stretch',
    minWidth: 0,
  },
  nameText: {
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitleText: {
    color: iosSystemColors.systemGray,
    marginTop: 2,
    textAlign: 'center',
  },
  // The row carries the 2pt rhythm the subtitle sets; the label inside it must
  // not add a second one, or the glyph and the text sit on different baselines.
  hiddenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: 2,
  },
  hiddenText: {
    color: iosSystemColors.systemGray,
  },
  // Same grey as the subtitle it sits under — the rules are context, not a
  // second headline competing with the name and the grade.
  rulesText: {
    color: iosSystemColors.systemGray,
    marginTop: 2,
    textAlign: 'center',
  },
});
