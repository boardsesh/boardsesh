import { memo, useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { formatSends, formatQuality } from '../../lib/format-climb-stats';
import { Text } from '../Text';
import { MarqueeText } from '../MarqueeText';
import { DrawerHeader } from '../DrawerHeader';
import { ClimbAttributeIcons } from '../ClimbAttributeIcons';
import { AscentStatusGlyph, AscentStatusMark } from '../AscentStatusGlyph';
import type { AscentStatusValue } from '../../lib/ascent-status-utils';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

type PlayDrawerHeaderBaseProps = {
  name: string;
  /** Display label (already formatted to V or Font per user preference). */
  difficulty: string;
  /** Raw difficulty (e.g. "6a/V3") used for grade-color lookup. Optional —
   *  falls back to `difficulty` if not provided. */
  rawDifficulty?: string;
  /** Explicit grade colour, overriding the internal `getGradeColor` lookup. The
   *  play drawer passes this so the colour matches the shown grade when the "Show
   *  Boardsesh grades" toggle swaps the label to the Boardsesh grade. Falls back
   *  to `getGradeColor(rawDifficulty ?? difficulty)` when omitted. */
  gradeColor?: string;
  qualityAverage: string;
  ascensionistCount: number;
  setterUsername: string;
  /** Intrinsic attributes shown as grey glyphs after the name. */
  benchmarkDifficulty?: string | null;
  /** Climb characteristics; no-match and MoonBoard method_* tokens render as glyphs/labels. */
  characteristics?: string[] | null;
  /** Left-aligned element on the name's row (e.g. the on-wall status). The header
   *  balances both flanks so the name stays centered. */
  leading?: ReactNode;
  /** Long-press handler on the name (copies it to the clipboard). When omitted the
   *  name is a plain, non-interactive label — used for the swipe "peek" header. */
  onLongPressName?: () => void;
};

type PlayDrawerHeaderProps = PlayDrawerHeaderBaseProps &
  (
    | {
        /** The climb and angle used by the root-board live status lookup. */
        climbUuid: string;
        angle: number;
        ascentStatus?: undefined;
      }
    | {
        /** A status resolved by a foreign-board drawer's board-specific index. */
        ascentStatus: AscentStatusValue | null;
        climbUuid?: never;
        angle?: never;
      }
  );

export const PlayDrawerHeader = memo(function PlayDrawerHeader(props: PlayDrawerHeaderProps) {
  const {
    name,
    difficulty,
    rawDifficulty,
    gradeColor,
    qualityAverage,
    ascensionistCount,
    setterUsername,
    benchmarkDifficulty,
    characteristics,
    leading,
    onLongPressName,
  } = props;
  const { t } = useTranslation('climbs');
  const resolvedGradeColor = useMemo(
    () => gradeColor ?? getGradeColor(rawDifficulty ?? difficulty) ?? DEFAULT_GRADE_COLOR,
    [gradeColor, rawDifficulty, difficulty],
  );

  const subtitleParts: string[] = [];
  if (ascensionistCount > 0) subtitleParts.push(formatSends(ascensionistCount, t));
  const qualityNum = parseFloat(qualityAverage);
  if (qualityNum > 0) subtitleParts.push(`${formatQuality(qualityAverage)}★`);
  if (setterUsername) subtitleParts.push(setterUsername);

  return (
    <DrawerHeader
      leading={leading}
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
            <ClimbAttributeIcons benchmarkDifficulty={benchmarkDifficulty} characteristics={characteristics} />
            {/* Undefined selects the root BoardProvider's live lookup; foreign-board
                callers always provide a resolved status, including explicit null. */}
            {props.ascentStatus === undefined ? (
              <AscentStatusGlyph climbUuid={props.climbUuid} angle={props.angle} style={styles.ascentStatus} />
            ) : (
              <AscentStatusMark status={props.ascentStatus} style={styles.ascentStatus} />
            )}
          </View>
          <Text variant="caption1" style={styles.subtitleText} numberOfLines={1}>
            {subtitleParts.join(' · ')}
          </Text>
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
  subtitleText: {
    color: iosSystemColors.systemGray,
    marginTop: 2,
    textAlign: 'center',
  },
  ascentStatus: {
    marginLeft: spacing[1],
  },
});
