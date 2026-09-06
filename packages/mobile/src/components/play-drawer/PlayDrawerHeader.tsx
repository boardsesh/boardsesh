import { memo, useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { CLIMB_CHARACTERISTICS, type BoardName, type Climb } from '@boardsesh/shared-schema';
import { useEffectiveClimbStats } from '@boardsesh/board-react';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { formatSends, formatQuality } from '../../lib/format-climb-stats';
import { Text } from '../Text';
import { MarqueeText } from '../MarqueeText';
import { DrawerHeader } from '../DrawerHeader';
import { ClimbAttributeIcons } from '../ClimbAttributeIcons';
import { PlayDrawerPlaylistChips } from './PlayDrawerPlaylistChips';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { WALL_STATE_PILL_TOUCH_HEIGHT } from '../../theme/layout';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { resolveClimbRuleLabels } from './climb-rule-labels';

/**
 * Gap between the climb name and the stats line under it, in points.
 *
 * Small enough to matter: the play drawer's first screen is a FIXED height with
 * the board art `flex: 1` inside it, so every point this header takes is a point
 * the board renderer loses. The whole centre column has to fit under the
 * `minRowHeight` floor the wall-state pill already sets:
 *
 *   body line height + THIS + caption1 line height  <=  WALL_STATE_PILL_TOUCH_HEIGHT
 *   iOS (HIG scale)       22 + 2 + 16 = 40  <= 44
 *   Android (M3 scale)    24 + 2 + 16 = 42  <= 44
 *
 * Both variants clear it with room to spare, which is why the playlist tags ride
 * *inside* the stats line as caption text rather than taking a line, or a taller
 * row, of their own — they cost the board renderer nothing. `PlaylistChipsRow`'s
 * `inline` variant carries no container and no `minHeight` precisely so this stays
 * true. See `play-drawer-header-layout-budget.test.tsx`, which pins the sum for
 * both type scales.
 *
 * The climb-RULES line below is the deliberate exception: it is allowed to grow
 * the header (and push the board down) because a truncated rule is worse than a
 * shorter board. Membership in a playlist does not clear that bar.
 */
export const STATS_ROW_MARGIN_TOP = 2;

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
  /** The board being played. Boards whose `explicitClimbRules` capability is on
   *  (Woods) print both climb rules under the subtitle; everything else keeps the
   *  exception-only glyph cluster beside the name. */
  boardName?: BoardName;
  /** Left-aligned element on the name's row (e.g. the on-wall status). The header
   *  balances both flanks so the name stays centered. The swipe peek passes a
   *  reserve-only copy so the incoming header matches this one exactly. */
  leading?: ReactNode;
  /** Long-press handler on the name (copies it to the clipboard). When omitted the
   *  name is a plain, non-interactive label — used for the swipe "peek" header. */
  onLongPressName?: () => void;
  /** Playlist-membership tags. Rendered *inside* the stats row, not under it: the
   *  board art below is `flex: 1` in a fixed-height first screen, so a line of its
   *  own would come straight off the board — and a line that appeared for one climb
   *  and not the next would resize the board on every swipe. See
   *  `STATS_ROW_MARGIN_TOP`. */
  playlistChips?: ReactNode;
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
  boardName,
  leading,
  onLongPressName,
  playlistChips,
}: PlayDrawerHeaderProps) {
  const { t } = useTranslation('climbs');
  const resolvedGradeColor = useMemo(
    () => gradeColor ?? getGradeColor(rawDifficulty ?? difficulty) ?? DEFAULT_GRADE_COLOR,
    [gradeColor, rawDifficulty, difficulty],
  );

  const subtitleParts: string[] = [];
  if (ascensionistCount > 0) subtitleParts.push(formatSends(ascensionistCount, t));
  const qualityNum = qualityAverage == null ? Number.NaN : parseFloat(qualityAverage);
  if (qualityAverage != null && qualityNum > 0) subtitleParts.push(`${formatQuality(qualityAverage)}★`);
  if (setterUsername) subtitleParts.push(setterUsername);

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
            />
          </View>
          {/* Stats and playlist tags share ONE line, both `caption1`, so the row is
              exactly one caption tall for a climb in a playlist and one in none —
              no reserved height to keep in sync, and nothing off the board art.
              The tag leads: it's the thing the climber came to check, and the
              stats behind it ellipsize from the tail (the setter) under squeeze. */}
          <View style={styles.subtitleRow}>
            {playlistChips}
            <Text variant="caption1" style={styles.subtitleText} numberOfLines={1}>
              {subtitleParts.join(' · ')}
            </Text>
          </View>
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
        <Text variant="headline" style={[styles.gradeText, { color: resolvedGradeColor }]} numberOfLines={1}>
          {difficulty}
        </Text>
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
  /** Whether this header may fetch the climb's playlist membership. True for the
   *  climb on screen, false for the swipe "peek" (see `PlayDrawerPlaylistChips`). */
  fetchPlaylistMembership?: boolean;
};

/** The only play-header child subscribed to the exact live-stat key. */
export const LivePlayDrawerHeader = memo(function LivePlayDrawerHeader({
  climb,
  boardName,
  layoutId,
  angle,
  leading,
  onLongPressName,
  fetchPlaylistMembership = false,
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
      benchmarkDifficulty={climb.benchmark_difficulty}
      characteristics={climb.characteristics}
      boardName={boardName}
      leading={leading}
      onLongPressName={onLongPressName}
      playlistChips={
        <PlayDrawerPlaylistChips
          climbUuid={climb.uuid}
          boardName={boardName}
          layoutId={layoutId}
          fetchMembership={fetchPlaylistMembership}
        />
      }
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
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    marginTop: STATS_ROW_MARGIN_TOP,
    alignSelf: 'stretch',
  },
  subtitleText: {
    color: iosSystemColors.systemGray,
    textAlign: 'center',
    // Yields when a playlist tag shares the line, so a long setter name
    // ellipsizes rather than shoving the tag out of the row.
    flexShrink: 1,
    minWidth: 0,
  },
  // Same grey as the subtitle it sits under — the rules are context, not a
  // second headline competing with the name and the grade.
  rulesText: {
    color: iosSystemColors.systemGray,
    marginTop: 2,
    textAlign: 'center',
  },
});
