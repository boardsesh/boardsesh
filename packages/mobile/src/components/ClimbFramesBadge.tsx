import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { Icon } from './Icon';
import { useTheme } from '../providers/theme-provider';
import { borderRadius } from '../theme/tokens';
import { isMultiFrameClimb } from '../lib/is-multi-frame-climb';

export { isMultiFrameClimb } from '../lib/is-multi-frame-climb';

/**
 * Fixed white ink on a dark translucent scrim stays distinct from board art in
 * either colour scheme. The pale hairline separates the badge from dark images.
 * Device QA must still confirm legibility over the actual thumbnails.
 */
const BADGE_INK = '#FFFFFF';
const BADGE_SCRIM = 'rgba(0, 0, 0, 0.72)';
const BADGE_EDGE = 'rgba(255, 255, 255, 0.45)';

/** Stack glyph stays secondary to the name and grade. */
const GLYPH_SIZE = 11;

type ClimbFramesBadgeProps = {
  /** Number of frames on the climb. Below 2 the badge renders nothing. */
  framesCount: number;
  /** Picture off: join the name-line badges instead of overlaying board art. */
  placement?: 'thumbnail' | 'inline';
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
  placement = 'thumbnail',
}: ClimbFramesBadgeProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const ink = placement === 'inline' ? systemColors.secondaryLabel : BADGE_INK;

  if (!isMultiFrameClimb(framesCount)) return null;

  return (
    <View
      // Group the decorative glyph and visible count into the one labelled
      // screen-reader element. `accessibilityRole` does not establish that
      // grouping by itself on every React Native platform.
      accessible
      accessibilityRole="text"
      accessibilityLabel={t('mobile.climbRow.frameCount', { count: framesCount })}
      style={placement === 'inline' ? styles.inlineBadge : styles.badge}
    >
      <Icon name="frames" size={GLYPH_SIZE} color={ink} />
      <Text variant="caption2" color={ink} style={styles.count}>
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
  inlineBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 2,
    marginStart: 4,
  },
  count: {
    fontWeight: '700',
  },
});
