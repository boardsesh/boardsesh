import { PressableSurface } from '../PressableSurface';
import { memo, useMemo, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
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
import { DraftChip } from '../DraftChip';
import { ProjectChip } from '../ProjectChip';
import { useTheme } from '../../providers/theme-provider';
import { PLAY_HEADER_TRAILING_MIN_WIDTH, WALL_STATE_PILL_TOUCH_HEIGHT } from '../../theme/layout';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { resolveClimbRuleLabels } from './climb-rule-labels';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useMyGrade } from '../../hooks/use-my-grade';
import { renderDifficulty } from '../../lib/boardsesh-grade-display';
import { derivePersonalGradeDisplay } from '@boardsesh/logbook';
import { climbStatsKnown, isProjectClimb, splitGradeLabel } from '@boardsesh/play-view';

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
  /** `climb.is_draft` — only the setter can see this climb. Prints the Draft chip
   *  beside the name, so the drawer says why the climb is not in the Climbs list. */
  isDraft?: boolean;
  /** Left-aligned element on the name's row (e.g. the on-wall status). The header
   *  balances both flanks so the name stays centered. The swipe peek passes a
   *  reserve-only copy so the incoming header matches this one exactly. */
  leading?: ReactNode;
  /** Long-press handler on the name (copies it to the clipboard). When omitted the
   *  name is a plain, non-interactive label — used for the swipe "peek" header. */
  onLongPressName?: () => void;
  /** The crowd's grade, demoted to a small `people`-marked line under the main
   *  one. Only set when it disagrees with the grade the climber gave (#4796). */
  secondaryGrade?: string | null;
  /** True when the main grade is the climber's own AND differs from the crowd's,
   *  which puts a `person` glyph on it. */
  markedAsMine?: boolean;
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
  isDraft = false,
  leading,
  onLongPressName,
  secondaryGrade,
  markedAsMine = false,
  onPressSetter,
  statsAngle,
  angle,
}: PlayDrawerHeaderProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  // The header's height is pinned (see `minRowHeight` below) and the headline's
  // line height alone eats that floor once type is scaled up, so the second line
  // is dropped rather than clamping anyone's Dynamic Type. The same information
  // is spelled out in the Grades section below, which scrolls.
  const { fontScale } = useWindowDimensions();
  const dropSecondaryLine = fontScale > 1.3;
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
            <PressableSurface
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
            </PressableSurface>
            {/* Keep rules the matching/feet line does not state, including no kickboard. */}
            <ClimbAttributeIcons
              benchmarkDifficulty={benchmarkDifficulty}
              characteristics={residualCharacteristics?.length ? residualCharacteristics : null}
              isNoMatch={ruleLabels ? undefined : isNoMatch}
            />
            {/* In the name row, not a caption line of its own like Hidden: the
                chip is one word, and a new line would move the board down for
                every draft. */}
            {isDraft ? <DraftChip style={styles.draftChip} testID="play-drawer-climb-draft" /> : null}
          </View>
          <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.subtitleText} numberOfLines={1}>
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
              <Icon maxFontSizeMultiplier={1} name="visibility.off" size={14} color={systemColors.secondaryLabel} />
              <Text variant="caption1" color={systemColors.secondaryLabel}>
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
              color={systemColors.secondaryLabel}
              style={styles.rulesText}
              accessibilityLabel={ruleLabels.accessibilityLabel}
              testID="play-drawer-climb-rules"
            >
              {ruleLabels.parts.join(' · ')}
            </Text>
          ) : null}
        </>
      }
      trailingMinWidth={PLAY_HEADER_TRAILING_MIN_WIDTH}
      trailing={
        <View style={styles.gradeColumn}>
          <View style={styles.gradeRow}>
            {/* The play drawer is the screen you hand your partner to show them
                the beta, so an unlabelled headline number that is actually your
                private opinion needs to say so. */}
            {markedAsMine ? (
              <Icon maxFontSizeMultiplier={1} name="person" size={13} color={systemColors.secondaryLabel} />
            ) : null}
            {/* Nobody has graded it yet (#5971): say so rather than leave the
                slot blank. */}
            {isProjectClimb({ gradeLabel: difficulty, isDraft, statsKnown: climbStatsKnown(boardName, statsAngle) }) ? (
              <ProjectChip testID="play-drawer-climb-project" />
            ) : (
              <Text variant="headline" style={[styles.gradeText, { color: resolvedGradeColor }]} numberOfLines={1}>
                {difficulty}
              </Text>
            )}
          </View>
          {secondaryGrade && !dropSecondaryLine ? (
            <View style={styles.gradeRow}>
              <Icon maxFontSizeMultiplier={1} name="people" size={11} color={systemColors.secondaryLabel} />
              <Text
                variant="caption2"
                color={systemColors.secondaryLabel}
                style={styles.secondaryGradeText}
                numberOfLines={1}
              >
                {secondaryGrade}
              </Text>
            </View>
          ) : null}
          {showSetAngleMarker ? (
            <Text
              variant="caption2"
              numberOfLines={1}
              accessibilityLabel={t('mobile.climbRow.setAngleMarkerAria', { angle: statsAngle })}
              color={systemColors.secondaryLabel}
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
  const { gradeFormat } = useGradeFormat();
  const liveStats = useEffectiveClimbStats(boardName, layoutId, climb.uuid, angle, {
    ascensionistCount: climb.ascensionist_count,
    qualityAverage: climb.quality_average,
    difficulty: climb.difficulty,
  });
  const displayedGrade = resolveGrade(
    {
      ...climb,
      difficulty: liveStats.difficulty,
    },
    boardName,
  );

  // Your grade wins over the crowd's. Resolved ABOVE `resolveGrade`, never
  // inside it — that resolver's contract is community-grades-only.
  // Falls back to the device's own ticks table while the logbook is unresolved,
  // so the drawer shows the climber's grade offline too — the same grade the
  // on-device search placed this climb by.
  const myGrade = useMyGrade(climb.uuid, angle, { localFallback: true });
  const mine = myGrade.status === 'set' ? renderDifficulty(myGrade.difficultyId, gradeFormat, boardName) : null;
  const personal = derivePersonalGradeDisplay(mine?.label ?? null, displayedGrade.label);
  const showsMine = personal.source === 'personal' && mine !== null;

  return (
    <PlayDrawerHeader
      name={climb.name}
      difficulty={showsMine ? mine.label : displayedGrade.label}
      rawDifficulty={liveStats.difficulty}
      gradeColor={showsMine ? mine.color : displayedGrade.color}
      markedAsMine={showsMine && personal.markPrimary}
      secondaryGrade={showsMine ? (splitGradeLabel(personal.secondaryLabel)[0] ?? null) : null}
      qualityAverage={liveStats.qualityAverage}
      ascensionistCount={liveStats.ascensionistCount}
      setterUsername={climb.setter_username}
      onPressSetter={onPressSetter}
      benchmarkDifficulty={climb.benchmark_difficulty}
      characteristics={climb.characteristics}
      isNoMatch={climb.is_no_match}
      boardName={boardName}
      isHidden={climb.is_hidden === true}
      isDraft={climb.is_draft === true}
      leading={leading}
      onLongPressName={onLongPressName}
      statsAngle={climb.statsAngle}
      angle={angle}
    />
  );
});

const styles = StyleSheet.create({
  // Deliberately uncoloured, same as the search-list row's marker — colour in
  // this slot carries the grade and nothing else.
  setAngleMarkerText: {
    textAlign: 'right',
  },
  gradeText: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    textAlign: 'right',
  },
  // Stacks the grade, the crowd's line when it disagrees with yours, and the
  // optional "set at N°" marker, so each sits right under the grade it
  // qualifies, all right-aligned in the trailing slot.
  gradeColumn: {
    alignItems: 'flex-end',
    gap: 1,
  },
  gradeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  secondaryGradeText: {
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    marginTop: -2,
    textAlign: 'right',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
  },
  draftChip: {
    marginStart: 6,
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
  // Same grey as the subtitle it sits under — the rules are context, not a
  // second headline competing with the name and the grade.
  rulesText: {
    marginTop: 2,
    textAlign: 'center',
  },
});
