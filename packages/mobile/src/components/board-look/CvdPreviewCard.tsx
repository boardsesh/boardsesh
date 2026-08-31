import React, { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { BoardImageNative } from '../BoardImageNative';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight } from '../../lib/haptics';
import { springs } from '../../theme/animations';
import { BOARD_PREVIEW_RENDER_WIDTH, type BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import type { CvdPreviewOption, CvdPreviewOptionId } from '../../lib/board-render/cvd-preview-options';
import { borderRadius, spacing } from '../../theme/tokens';
import { textStyles } from '../../theme/typography';

/** Same 168pt square as the board-look preset rail, so the two rails read as one component. */
export const CVD_PREVIEW_CARD_WIDTH = 168;

/**
 * One line for the name — every one of the four is a single word — and two for
 * the description, which is a whole sentence ("Red and green look alike, and
 * reds look darker."). Reserved either way, so a card whose description wraps to
 * one line keeps the row's bottom edge on the same baseline as one that wraps to
 * two.
 */
const TITLE_LINES = 1;
const SUBTITLE_LINES = 2;

/**
 * Total height of a card: the square thumb, the gap under it, the reserved
 * one-line title and the reserved two-line description.
 *
 * A constant rather than a measurement, for the same reason
 * `BOARD_LOOK_CARD_HEIGHT` is one: a host pinning a fixed-height row needs it
 * before anything has laid out. Safe in both UI variants — HIG and Material give
 * `subheadline` the same 20pt lineHeight and `caption1` the same 16pt one.
 */
export const CVD_PREVIEW_CARD_HEIGHT =
  CVD_PREVIEW_CARD_WIDTH +
  spacing[2] +
  TITLE_LINES * textStyles.subheadline.lineHeight +
  SUBTITLE_LINES * textStyles.caption1.lineHeight;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type CvdPreviewCardProps = {
  option: CvdPreviewOption;
  preview: BoardPreviewSource;
  /**
   * Draw the card's frame and label but mount NO board image.
   *
   * Four simultaneous board renders is the real cost of this rail, and only two
   * cards fit on a phone. Cards the climber has not scrolled to yet stay a plate
   * until they do; once seen, never un-seen.
   */
  showSkeleton: boolean;
  onPress: (id: CvdPreviewOptionId) => void;
};

/**
 * The climber's own board, redrawn through one colour-vision simulation.
 *
 * Same anatomy as `BoardLookPreviewCard` — bare container, square bordered
 * thumb, title over a caption — so the accessibility rail and the board-look
 * rail read as one component.
 *
 * There is NO selected state here: this is a viewer, not a picker. Every card
 * keeps the same separator ring, and none carries a badge. Press feedback on an
 * inert card would be a lie the climber only discovers by tapping, so tapping
 * does something real — it opens this simulation full size, which is the size a
 * "can I tell these two marks apart?" judgement actually needs.
 *
 * Only the holds overlay is simulated. The board photograph is drawn as it is;
 * `expo-image` has no colour-matrix prop and Skia is deliberately not installed.
 * The rail carries `cvd.photoNote` under it so the card never implies otherwise.
 *
 * Memoized, and `onPress` takes the option id, so the carousel's `renderItem`
 * needs no per-card closure.
 */
export const CvdPreviewCard = React.memo(function CvdPreviewCard({
  option,
  preview,
  showSkeleton,
  onPress,
}: CvdPreviewCardProps) {
  const { t } = useTranslation('common');
  const { systemColors, textStyles: resolvedTextStyles } = useTheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePress = useCallback(() => {
    hapticLight();
    onPress(option.id);
  }, [onPress, option.id]);

  const title = t(option.titleI18nKey);
  const subtitle = t(option.subtitleI18nKey);
  // Read from the resolved scale rather than the HIG constant: the two variants
  // agree today, but the reserved text box has to keep baselines aligned in
  // whichever one is active.
  const titleLineHeight = resolvedTextStyles.subheadline.lineHeight ?? textStyles.subheadline.lineHeight;
  const subtitleLineHeight = resolvedTextStyles.caption1.lineHeight ?? textStyles.caption1.lineHeight;

  return (
    <AnimatedPressable
      accessibilityRole="button"
      // No `accessibilityState.selected` on purpose — nothing here is selectable.
      accessibilityLabel={`${title}. ${subtitle}`}
      accessibilityHint={t('mobile.more.accessibility.cvd.openLarger')}
      onPress={handlePress}
      onPressIn={() => (scale.value = withSpring(0.97, springs.snappy))}
      onPressOut={() => (scale.value = withSpring(1, springs.snappy))}
      style={[animatedStyle, styles.container]}
    >
      <View
        testID="cvd-preview-thumb"
        style={[
          styles.thumb,
          { backgroundColor: systemColors.tertiaryBackground, borderColor: systemColors.separator },
        ]}
        // One element per card, not a walk through the layered board and holds
        // images — the same treatment `MarkerSwatch` gives its shape SVG. The
        // picture is exactly the part a screen-reader user cannot use; the
        // verdict line under the rail is what carries this for them.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {showSkeleton ? (
          <View testID="cvd-preview-skeleton" style={[styles.skeleton, { backgroundColor: systemColors.fill }]} />
        ) : (
          <BoardImageNative
            frames={preview.frames}
            boardName={preview.boardName}
            layoutId={preview.layoutId}
            sizeId={preview.sizeId}
            setIds={preview.setIds}
            boardWidth={preview.boardWidth}
            boardHeight={preview.boardHeight}
            renderWidth={BOARD_PREVIEW_RENDER_WIDTH}
            // No `renderSettingsOverride`: every card draws the climber's own
            // stored look. The only thing that differs is the colour transform.
            holdColorTransform={option.transform}
            holdColorTransformKey={option.transformKey}
            // Every card draws the SAME climb, so the simulation is what
            // identifies this overlay. FlashList recycles rows, and without a
            // key that changes with the option a recycled view keeps showing the
            // previous card's overlay until the new one decodes.
            recyclingKey={option.id}
            // Letterboxed, NOT cropped: a board is taller than it is wide, and
            // filling a square would cut off the top and bottom holds. Judging
            // all four roles against each other is the entire point of this
            // rail, so dropping two rows of them would defeat it.
            style={styles.boardImage}
          />
        )}
      </View>

      <Text
        variant="subheadline"
        numberOfLines={TITLE_LINES}
        style={[styles.title, { minHeight: TITLE_LINES * titleLineHeight }]}
      >
        {title}
      </Text>
      <Text
        variant="caption1"
        color={systemColors.secondaryLabel}
        numberOfLines={SUBTITLE_LINES}
        style={{ minHeight: SUBTITLE_LINES * subtitleLineHeight }}
      >
        {subtitle}
      </Text>
    </AnimatedPressable>
  );
});

const styles = StyleSheet.create({
  container: {
    width: CVD_PREVIEW_CARD_WIDTH,
  },
  thumb: {
    width: CVD_PREVIEW_CARD_WIDTH,
    height: CVD_PREVIEW_CARD_WIDTH,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    // Constant width AND constant colour: no card here is ever "the chosen one",
    // and the thumb letterboxes its image, so any border change would resize
    // that image rather than just recolour a frame.
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing[2],
  },
  boardImage: {
    // `width: 'auto'` overrides BoardImageNative's own `width: '100%'` so its
    // aspectRatio resolves off the height instead — the letterbox.
    width: 'auto',
    height: '100%',
  },
  skeleton: {
    width: '100%',
    height: '100%',
  },
  title: {
    fontWeight: '600',
  },
});
