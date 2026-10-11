import { View, StyleSheet, useWindowDimensions, type ColorValue, type StyleProp, type ViewStyle } from 'react-native';
import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from './ClimbListThumbnail';
import { ClimbRowReservedLine } from './ClimbRowReservedLine';
import { PROGRESS_MAX_FONT_SCALE } from '../lib/climb-progress';
import type { TextVariant } from './Text';
import { useClimbRowDisplay } from '../lib/climb-row-display-preference';
import { useTheme } from '../providers/theme-provider';
import { borderRadius, spacing } from '../theme/tokens';
import { CLIMB_ROW_GUTTER } from './climb-list-row-styles';
import {
  CLIMB_ROW_DIRECTION_STATUS,
  CLIMB_ROW_LINE_GAP,
  CLIMB_ROW_MIN_TEXT_COLUMN_HEIGHT,
  CLIMB_ROW_TAGS_LINE,
  DEFAULT_CLIMB_ROW_SURFACE,
  climbRowLayout,
  climbRowNameLines,
} from './climb-row-layout';

type ClimbListRowSkeletonProps = {
  /** The rows this stands in for can show playlist tags. Only the Climbs list's can. */
  showPlaylistChips?: boolean;
  showProgress?: boolean;
  /** The board whose climbs are loading mirrors, so its rows track each direction. */
  supportsMirroring?: boolean;
};

/**
 * One line of a row without a thumbnail: a bar on a real, empty line of the
 * text the bar stands for. The line gives the height, so the placeholder is as
 * tall as the row that replaces it at any text size.
 */
function SkeletonTextLine({
  variant,
  barStyle,
  color,
  minHeight,
}: {
  variant: TextVariant;
  barStyle: StyleProp<ViewStyle>;
  color: ColorValue;
  minHeight?: number;
}) {
  return (
    <View style={[styles.textLine, minHeight === undefined ? null : { minHeight }]}>
      <View style={[barStyle, { backgroundColor: color }]} />
      <ClimbRowReservedLine variant={variant} />
    </View>
  );
}

/**
 * The placeholder for a climb row that is still loading. It reads the climber's
 * Climb list settings and takes its shape from the same layout function as the
 * row, so it has that row's thumbnail or none, its lines, its height and its
 * separator, and nothing shifts when the climbs land.
 */
export function ClimbListRowSkeleton({
  showPlaylistChips = false,
  showProgress = false,
  supportsMirroring = false,
}: ClimbListRowSkeletonProps) {
  const { systemColors } = useTheme();
  const display = useClimbRowDisplay();
  const { fontScale } = useWindowDimensions();
  const { textStyles } = useTheme();
  const layout = climbRowLayout({
    display,
    surface: { ...DEFAULT_CLIMB_ROW_SURFACE, showPlaylistChips, showProgress },
    supportsMirroring,
    fontScale,
    typeScale: textStyles,
  });
  const blockColor = systemColors.fill;

  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="climb-list-row-skeleton">
      <View
        style={[
          styles.contentRow,
          { backgroundColor: systemColors.background },
          layout.hasThumbnail && layout.estimatedHeight === 112 ? null : { minHeight: layout.estimatedHeight },
        ]}
      >
        {layout.hasThumbnail ? (
          <>
            <View style={[styles.thumbnail, { backgroundColor: blockColor }]} />
            {/* Beside a thumbnail the row's height is the thumbnail's, so two
                bars centred on it are enough: the lines that load late grow
                inside that height in the row too. */}
            <View style={styles.centerColumn}>
              <View style={[styles.titleBlock, { backgroundColor: blockColor }]} />
              {layout.hasDetailLine ? <View style={[styles.subtitleBlock, { backgroundColor: blockColor }]} /> : null}
            </View>
          </>
        ) : (
          // Without one the row is as tall as its lines, so each line the row
          // will have is here, the ones it only reserves included.
          <View style={styles.textColumn}>
            <SkeletonTextLine
              variant="body"
              barStyle={styles.titleBlock}
              color={blockColor}
              minHeight={
                climbRowNameLines(fontScale) === 2 ? (textStyles.body.lineHeight ?? 22) * fontScale * 2 : undefined
              }
            />
            {layout.hasDetailLine ? (
              <SkeletonTextLine variant="footnote" barStyle={styles.subtitleBlock} color={blockColor} />
            ) : null}
            {layout.hasPersonalLine ? (
              <View style={styles.personalLine}>
                <ClimbRowReservedLine
                  variant={layout.hasProgressLine ? 'footnote' : 'caption2'}
                  {...(layout.hasProgressLine ? { maxFontSizeMultiplier: PROGRESS_MAX_FONT_SCALE } : null)}
                />
              </View>
            ) : null}
            {layout.hasTagsLine ? (
              <View style={styles.tagsLine}>
                <ClimbRowReservedLine variant="caption1" maxFontSizeMultiplier={CLIMB_ROW_TAGS_LINE.maxFontScale} />
              </View>
            ) : null}
          </View>
        )}
        <View style={[styles.gradeBlock, { backgroundColor: blockColor }]} />
      </View>
      <View
        style={[styles.separator, { marginStart: layout.separatorInset, backgroundColor: systemColors.separator }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: CLIMB_ROW_GUTTER,
    paddingVertical: spacing[2],
    gap: spacing[3],
  },
  thumbnail: {
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
    borderRadius: borderRadius.md,
    opacity: 0.55,
  },
  centerColumn: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 8,
  },
  // The row's own text column: the same gap between lines and the same floor.
  textColumn: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: CLIMB_ROW_LINE_GAP,
    minHeight: CLIMB_ROW_MIN_TEXT_COLUMN_HEIGHT,
  },
  textLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // The two lines a row only reserves until its data lands. Empty here as they
  // are there, and sized from the numbers the row's own lines are drawn with.
  personalLine: {
    minHeight: CLIMB_ROW_DIRECTION_STATUS.iconSize,
  },
  tagsLine: {
    marginTop: CLIMB_ROW_TAGS_LINE.marginTop,
    paddingVertical: CLIMB_ROW_TAGS_LINE.chipPaddingVertical,
    minHeight: CLIMB_ROW_TAGS_LINE.chipMinHeight,
    justifyContent: 'center',
  },
  titleBlock: {
    width: '70%',
    height: 18,
    borderRadius: borderRadius.full,
    opacity: 0.55,
  },
  subtitleBlock: {
    width: '46%',
    height: 12,
    borderRadius: borderRadius.full,
    opacity: 0.4,
  },
  gradeBlock: {
    width: 34,
    height: 20,
    borderRadius: borderRadius.full,
    opacity: 0.5,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
});
