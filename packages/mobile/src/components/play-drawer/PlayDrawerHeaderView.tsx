import { PressableSurface } from '../PressableSurface';
import { memo, useMemo, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CLIMB_CHARACTERISTICS, type BoardName } from '@boardsesh/shared-schema';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { formatSends, formatQuality } from '../../lib/format-climb-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { MarqueeText } from '../MarqueeText';
import { DrawerHeader } from '../DrawerHeader';
import { ClimbAttributeIcons } from '../ClimbAttributeIcons';
import { describeClimbAttributes, type ClimbAttributeInput } from '../climb-attribute-labels';
import { DraftChip } from '../DraftChip';
import { ProjectChip } from '../ProjectChip';
import { useTheme } from '../../providers/theme-provider';
import { PLAY_HEADER_TRAILING_MIN_WIDTH, WALL_STATE_PILL_TOUCH_HEIGHT } from '../../theme/layout';
import { resolveClimbRuleLabels } from './climb-rule-labels';
import { climbStatsKnown, isProjectClimb } from '@boardsesh/play-view';

/** Holds the stats line's height when there is nothing to print on it. */
const ZERO_WIDTH_SPACE = '\u200B';
/**
 * How far the climb name may shrink to fit whole before it scrolls instead: a
 * name up to ~10% too long for the header reads at 90% and keeps every glyph.
 */
export const NAME_SHRINK_TO_FIT_SCALE = 0.9;

export type PlayDrawerHeaderProps = {
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
   *  name is a plain, non-interactive label. */
  onLongPressName?: () => void;
  /**
   * A neighbour's header in the swipe, the one that crossfades in: drawn exactly
   * as it will be once its climb is current (the name at full strength, the
   * setter in its link colour), so nothing on it changes when the swipe
   * commits. It takes no touches: its slot passes them through, and the
   * handlers arrive with the commit.
   */
  peek?: boolean;
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

type HeaderFactsInput = Pick<
  PlayDrawerHeaderProps,
  | 'ascensionistCount'
  | 'qualityAverage'
  | 'boardName'
  | 'benchmarkDifficulty'
  | 'characteristics'
  | 'isNoMatch'
  | 'difficulty'
  | 'isDraft'
  | 'statsAngle'
  | 'angle'
>;

/**
 * The header's derived text, shared by what it draws and what the play drawer's
 * screen-reader stand-in reads (`describePlayDrawerHeader`), so the two never
 * say different things about the same climb.
 */
function deriveHeaderFacts(
  {
    ascensionistCount,
    qualityAverage,
    boardName,
    benchmarkDifficulty,
    characteristics,
    isNoMatch,
    difficulty,
    isDraft = false,
    statsAngle,
    angle,
  }: HeaderFactsInput,
  t: TFunction<'climbs'>,
) {
  // The climb's own facts and nothing else. Where the player is (a list, a
  // workout stage) and what the wall is doing live in the top bar
  // (`PlayListContext`): at the front of this one line they pushed the sends
  // and stars off the end on a phone (#6664, #6745).
  const statsParts: string[] = [];
  if (ascensionistCount > 0) statsParts.push(formatSends(ascensionistCount, t));
  const qualityNum = qualityAverage == null ? Number.NaN : parseFloat(qualityAverage);
  if (qualityAverage != null && qualityNum > 0) statsParts.push(`${formatQuality(qualityAverage)}★`);

  // Woods states both rules on every problem, so we do too — see the
  // `explicitClimbRules` capability. Recomputed per climb, which is also what
  // makes the swipe peek show the INCOMING climb's rules: both headers are this
  // component with their own climb's characteristics.
  const ruleLabels = getBoardCapabilities(boardName).explicitClimbRules
    ? resolveClimbRuleLabels(characteristics, t)
    : null;
  // Woods' rules line states matching and feet in full, so the glyph cluster
  // beside the name keeps only the rules that line does not (no kickboard among
  // them), and drops the legacy no-match bool, which would say it twice.
  const residualCharacteristics = ruleLabels
    ? characteristics?.filter(
        (token) =>
          token !== CLIMB_CHARACTERISTICS.NO_MATCH &&
          token !== CLIMB_CHARACTERISTICS.ANY_FEET &&
          token !== CLIMB_CHARACTERISTICS.CAMPUS,
      )
    : characteristics;
  const attributes: ClimbAttributeInput = {
    benchmarkDifficulty,
    boardName,
    characteristics: residualCharacteristics?.length ? residualCharacteristics : null,
    isNoMatch: ruleLabels ? undefined : isNoMatch,
  };

  // Nobody has graded it yet (#5971).
  const showsProject = isProjectClimb({
    gradeLabel: difficulty,
    isDraft,
    statsKnown: climbStatsKnown(boardName, statsAngle),
  });
  // Same marker, same key and styling as the search-list row (ClimbListItemContent):
  // this climb's grade/sends came from a different angle than the one on the wall.
  // It shares the row's narrow lag too: `statsAngle` is fixed at fetch time, so after
  // the first ever tick at the browsed angle the marker keeps naming the old angle
  // until the climb is refetched. Self-correcting; see the row's comment.
  const showsSetAngleMarker = statsAngle != null && statsAngle !== angle;
  return { statsParts, ruleLabels, attributes, showsProject, showsSetAngleMarker };
}

/**
 * The grade the header shows, as words: the grade itself, whole, or "Project"
 * when nobody has graded the climb. For the board's spoken value, which names
 * the climb by name and grade.
 */
export function describePlayDrawerGrade(headerProps: PreparedHeaderProps, t: TFunction<'climbs'>): string {
  return deriveHeaderFacts(headerProps, t).showsProject ? t('mobile.project.chip') : headerProps.difficulty;
}

/**
 * Everything the header shows, as one sentence for a screen reader: the play
 * drawer reads the header from one fixed stand-in (see `SwipeableHeader`), so
 * this is the only way the name, grade and stats reach VoiceOver or TalkBack.
 */
export function describePlayDrawerHeader(headerProps: PreparedHeaderProps, t: TFunction<'climbs'>): string {
  const { name, secondaryGrade, setterUsername, isHidden, isDraft, statsAngle } = headerProps;
  const { statsParts, ruleLabels, attributes, showsSetAngleMarker } = deriveHeaderFacts(headerProps, t);
  return [
    name,
    // The glyphs and badges drawn right after the name.
    ...describeClimbAttributes(attributes, t),
    isDraft ? t('createClimbForm.draftBadge') : null,
    describePlayDrawerGrade(headerProps, t),
    secondaryGrade,
    ...statsParts,
    setterUsername,
    isHidden ? t('mobile.hidden.banner') : null,
    ruleLabels?.accessibilityLabel,
    showsSetAngleMarker ? t('mobile.climbRow.setAngleMarkerAria', { angle: statsAngle }) : null,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(', ');
}

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
  peek = false,
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

  const { statsParts, ruleLabels, attributes, showsProject, showsSetAngleMarker } = deriveHeaderFacts(
    {
      ascensionistCount,
      qualityAverage,
      boardName,
      benchmarkDifficulty,
      characteristics,
      isNoMatch,
      difficulty,
      isDraft,
      statsAngle,
      angle,
    },
    t,
  );
  // A peek draws the setter as the link it becomes on commit, so the swap
  // changes nothing on screen.
  const setterAsLink = Boolean(setterUsername) && (onPressSetter !== undefined || peek);
  const subtitleParts = setterUsername && !setterAsLink ? [...statsParts, setterUsername] : statsParts;

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
            {/* Never dimmed on a peek: the disabled look (50%, 38% on Material)
                read as a greyed-out title for the whole swipe, then snapped to
                white when it committed. The same element either way, so the
                commit does not remount the name. */}
            <PressableSurface
              onLongPress={onLongPressName}
              disabled={!onLongPressName && !peek}
              feedback={onLongPressName ? 'scale' : 'none'}
              delayLongPress={350}
              accessibilityRole={onLongPressName ? 'button' : undefined}
              accessibilityHint={onLongPressName ? t('mobile.climbActions.copyNameHint') : undefined}
              style={styles.namePressable}
            >
              <MarqueeText
                active
                variant="body"
                style={styles.nameClip}
                textStyle={styles.nameText}
                fallbackLines={2}
                // A name a few points too long shrinks into place rather than
                // scrolling by those points, which left its first glyph clipped (#7017).
                shrinkToFitScale={NAME_SHRINK_TO_FIT_SCALE}
              >
                {name}
              </MarqueeText>
            </PressableSurface>
            {/* Keep rules the matching/feet line does not state, including no kickboard. */}
            <ClimbAttributeIcons {...attributes} />
            {/* In the name row, not a caption line of its own like Hidden: the
                chip is one word, and a new line would move the board down for
                every draft. */}
            {isDraft ? <DraftChip style={styles.draftChip} testID="play-drawer-climb-draft" /> : null}
          </View>
          <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.subtitleText} numberOfLines={1}>
            {/* Never an empty string: an empty line measures shorter than a full
                one at large text sizes, and a climb with no stats would then
                step the board against one that has them. */}
            {subtitleParts.length > 0 ? subtitleParts.join(' · ') : ZERO_WIDTH_SPACE}
            {setterAsLink ? (
              <Text variant="caption1" onPress={onPressSetter} accessibilityRole={onPressSetter ? 'link' : undefined}>
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
            {showsProject ? (
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
                emphasized
                variant="caption2"
                color={systemColors.secondaryLabel}
                style={styles.secondaryGradeText}
                numberOfLines={1}
              >
                {secondaryGrade}
              </Text>
            </View>
          ) : null}
          {showsSetAngleMarker ? (
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

export type PreparedHeaderProps = Omit<PlayDrawerHeaderProps, 'leading' | 'onLongPressName' | 'onPressSetter'>;

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
