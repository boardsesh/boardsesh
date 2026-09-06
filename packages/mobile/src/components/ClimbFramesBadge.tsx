import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { Icon } from './Icon';
import { borderRadius } from '../theme/tokens';

/**
 * Ink, scrim and edge of the frames chip. Fixed values, NOT theme colours: the
 * chip sits on board art, not on an app surface, so it has to be legible against
 * a photo rather than against `systemColors.background` — and the photo doesn't
 * change with the colour scheme.
 *
 * Why a scrim AND an edge, rather than one or the other:
 *
 * - White ink on the 72%-black scrim clears WCAG AA on both extremes of our board
 *   art. Over a near-black Kilter wall (~#101010, relative luminance ≈ 0.006) the
 *   composited chip lands at L ≈ 0.28·0.006 ≈ 0.002, so white reads at
 *   (1.0 + 0.05) / (0.002 + 0.05) ≈ 20:1. Over a bright Tension plywood wall
 *   (~#C8B48C, L ≈ 0.47) it lands at L ≈ 0.28·0.47 ≈ 0.13, so white still reads
 *   at (1.05) / (0.18) ≈ 5.8:1. Both are above the 4.5:1 floor.
 * - The scrim alone disappears INTO the near-black Kilter art — 20:1 on the text
 *   is useless if you can't see where the chip is. The 45%-white hairline is what
 *   separates the chip from a dark wall; against the bright wall the scrim itself
 *   already does that job.
 *
 * Contrast figures above are computed, not measured on a device — see the PR's
 * test plan for the device pass that still owes us the visual confirmation.
 */
const BADGE_INK = '#FFFFFF';
const BADGE_SCRIM = 'rgba(0, 0, 0, 0.72)';
const BADGE_EDGE = 'rgba(255, 255, 255, 0.45)';

/** Stack-glyph point size per density tier. The compact cell is 56×72, not 76×96. */
const GLYPH_SIZE = 11;
const COMPACT_GLYPH_SIZE = 9;

/**
 * Whether a climb is a multi-frame route rather than a single-frame boulder.
 *
 * Exported so the row can gate MOUNTING the badge on it: `ClimbFramesBadge` calls
 * `useTranslation`, and a hook can't be skipped from inside the component, so a
 * badge mounted on every row would add an i18n listener to every row in the list
 * for the sake of the handful that are routes (docs/react-native-performance.md —
 * no per-row subscriptions). The badge keeps its own guard as well, so mounting it
 * unconditionally is merely wasteful, never wrong.
 *
 * Boards whose `multiFrameClimbs` capability is false (Woods) can never produce a
 * count above 1, so this is false for every climb on such a board.
 */
export function isMultiFrameClimb(framesCount: number | null | undefined): boolean {
  return typeof framesCount === 'number' && framesCount > 1;
}

type ClimbFramesBadgeProps = {
  /** Number of frames on the climb. Below 2 the badge renders nothing. */
  framesCount: number;
  /** True on the compact density tier, whose thumbnail cell is 56×72. */
  compact?: boolean;
};

/**
 * Frame-count pip drawn over a climb thumbnail, marking a multi-frame route in a
 * list that mixes routes and boulders (#4635). Two jobs at once: it says "this is
 * a route, not a boulder" while filters allow both, and it explains why the
 * thumbnail looks sparse — the artwork is only the FIRST frame, so a good route
 * can read as an undesirable climb until you open it.
 *
 * A `View` with a `Text` in it, deliberately: board art is the app's largest
 * memory consumer (docs/react-native-performance.md §7 — foreground OOM kills on
 * 4 GB iPhones), so the pip adds no image layer and does not touch the
 * thumbnail's render width.
 *
 * Monochrome by the same rule as the row's ascent-status and favourite glyphs:
 * colour in a climb row means GRADE and nothing else, so a colour-blind climber
 * loses no signal here.
 */
export const ClimbFramesBadge = memo(function ClimbFramesBadge({
  framesCount,
  compact = false,
}: ClimbFramesBadgeProps) {
  const { t } = useTranslation('climbs');

  if (!isMultiFrameClimb(framesCount)) return null;

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={t('mobile.climbRow.frameCount', { count: framesCount })}
      style={[styles.badge, compact ? styles.badgeCompact : null]}
    >
      <Icon name="frames" size={compact ? COMPACT_GLYPH_SIZE : GLYPH_SIZE} color={BADGE_INK} />
      <Text variant="caption2" color={BADGE_INK} style={styles.count}>
        {String(framesCount)}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  // Bottom-right of the thumbnail cell: the top of a board photo is where the
  // finish holds sit, and covering those is what would actually mislead someone
  // scanning the list.
  badge: {
    position: 'absolute',
    right: 3,
    bottom: 3,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: borderRadius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BADGE_EDGE,
    backgroundColor: BADGE_SCRIM,
  },
  // The compact cell is 20pt narrower and 24pt shorter, so the chip pulls in to
  // the very corner and loses its horizontal breathing room.
  badgeCompact: {
    right: 2,
    bottom: 2,
    gap: 1,
    paddingHorizontal: 3,
  },
  count: {
    fontWeight: '700',
  },
});
