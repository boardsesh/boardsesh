import React, { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { BoardImageNative } from '../BoardImageNative';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight } from '../../lib/haptics';
import { springs } from '../../theme/animations';
import { BOARD_PREVIEW_RENDER_WIDTH, type BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import type { BoardLookOption, BoardLookOptionId } from '../../lib/board-render/board-look-options';
import type { BoardRenderSettings } from '../../lib/board-render-settings';
import { borderRadius, overlays, spacing } from '../../theme/tokens';
import { textStyles, CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';

export const BOARD_LOOK_CARD_WIDTH = 168;

/**
 * A look's name is one short word — "Boardsesh", "Classic", "Subtle" — so it
 * gets one line and no reserved second one. The board-selector card reserves two
 * because board names genuinely wrap; here that reservation only opened a
 * line-high gap between every name and its description.
 */
const TITLE_LINES = 1;

/**
 * The description IS a sentence, so it gets the two lines and the reservation.
 * Reserved whether or not this card's description wraps, so every card in the
 * row keeps its bottom edge on the same baseline.
 */
const DESCRIPTION_LINES = 2;

/**
 * Total height of a card: the square thumb, the gap under it, the one-line name,
 * and the reserved two-line description.
 *
 * A constant rather than a measurement because a host that pins a fixed-height
 * row needs it before anything has laid out. Safe in both UI variants: HIG and
 * Material give `subheadline` the same 20pt lineHeight and `caption1` the same
 * 16pt one, so the numbers below do not move with the type scale.
 */
export const BOARD_LOOK_CARD_HEIGHT =
  BOARD_LOOK_CARD_WIDTH +
  spacing[2] +
  TITLE_LINES * textStyles.subheadline.lineHeight +
  DESCRIPTION_LINES * textStyles.caption1.lineHeight;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type BoardLookPreviewCardProps = {
  option: BoardLookOption;
  preview: BoardPreviewSource;
  /**
   * The bundle this card draws under, or `undefined` to draw the climber's own
   * stored settings (the settings screen's Custom card). Comes from
   * `buildBoardLookPreviewSettings`, which must be memoized — this prop lands on
   * a `React.memo`'d image whose overlay effect re-fires on identity change.
   */
  renderSettingsOverride: BoardRenderSettings | undefined;
  selected: boolean;
  /**
   * Draw the card's frame and label but mount NO board image.
   *
   * Used while the capability probe has not answered. A Boardsesh card mounted
   * then would resolve to a classic render — `resolveEffectiveRenderSettings`
   * forces classic on an unverified library — and the climber would be picking
   * between labels over four identical classic boards.
   */
  showSkeleton: boolean;
  onPress: (id: BoardLookOptionId) => void;
};

/**
 * One board look, drawn on the climber's own board.
 *
 * Same anatomy as `BoardDiscoveryCard` — bare container, square bordered thumb,
 * scrim pill for the chosen one, two-line title over a one-line caption — so the
 * two horizontal rails in the app read as one component.
 *
 * Memoized, and `onPress` takes the option id, so the carousel's `renderItem`
 * needs no per-card closure and a selection change re-renders only the two
 * cards whose `selected` actually flipped.
 */
export const BoardLookPreviewCard = React.memo(function BoardLookPreviewCard({
  option,
  preview,
  renderSettingsOverride,
  selected,
  showSkeleton,
  onPress,
}: BoardLookPreviewCardProps) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors, textStyles: resolvedTextStyles } = useTheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePress = useCallback(() => {
    hapticLight();
    onPress(option.id);
  }, [onPress, option.id]);

  const label = t(option.labelI18nKey);
  const description = t(option.descriptionI18nKey);
  // Read from the resolved scale rather than the HIG constant: the two variants
  // agree on 20 today, but the reserved title box has to keep baselines aligned
  // in whichever one is active.
  const descriptionLineHeight = resolvedTextStyles.caption1.lineHeight ?? textStyles.caption1.lineHeight;

  // Only the thumb carries the frame, so selecting a card changes nothing about
  // the card's own box: the row keeps its height and the caption never shifts.
  // The picture inside gains/loses the ~1.5pt the border eats, and nothing else
  // moves.
  // Colour only — the width is constant in `styles.thumb`. This is the one place
  // the card deliberately diverges from the board-selector card, which grows its
  // border from a hairline on selection: there, selection is rare and each card
  // draws a different board. Here every card draws the SAME climb and selection
  // changes on every tap, and the thumb letterboxes its image, so a 1.5pt border
  // change resizes that image on each tap — the flicker fixed in 9e51e7394. An
  // unselected 2pt separator border reads the same as a hairline at this size.
  const thumbStyle = {
    backgroundColor: systemColors.tertiaryBackground,
    borderColor: selected ? brandColors.primary : systemColors.separator,
  };

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}. ${description}`}
      // The press does two different things, so say which one this card offers:
      // the look you are on opens bigger, the others get picked.
      accessibilityHint={selected ? t('mobile.more.accessibility.cvd.openLarger') : undefined}
      onPress={handlePress}
      onPressIn={() => (scale.value = withSpring(0.97, springs.snappy))}
      onPressOut={() => (scale.value = withSpring(1, springs.snappy))}
      style={[animatedStyle, styles.container]}
    >
      <View testID="board-look-thumb" style={[styles.thumb, thumbStyle]}>
        {showSkeleton ? (
          <View testID="board-look-skeleton" style={[styles.skeleton, { backgroundColor: systemColors.fill }]} />
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
            renderSettingsOverride={renderSettingsOverride}
            // Every card draws the SAME climb, so the option is what identifies
            // this overlay. FlashList recycles rows, and without a key that
            // changes with the option a recycled view keeps showing the previous
            // card's overlay until the new one decodes.
            recyclingKey={option.id}
            // Letterboxed, NOT cropped: a board is taller than it is wide, and
            // filling a square would cut off the top and bottom holds — the rows
            // a look is easiest to judge on. Height drives, the image's own
            // aspect ratio sets the width, and the thumb centres it, so the bars
            // land at the sides.
            style={styles.boardImage}
          />
        )}
        {option.placeholderOverlay && !showSkeleton ? (
          // The Custom card in onboarding: a real Boardsesh render, deliberately
          // obscured. There is nothing of the climber's own to show yet — the
          // point of the card is that they are about to go and build it.
          // Fills the THUMB, so it takes the corner radius with it.
          <View
            testID="board-look-placeholder"
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, styles.placeholder, { backgroundColor: systemColors.secondaryBackground }]}
          >
            <Text variant="largeTitle" color={systemColors.label}>
              ?
            </Text>
          </View>
        ) : null}

        {/* "This is the look you're on" reads as a word rather than a bare tick,
            the same way the active board does on the discovery rail. */}
        {selected ? (
          <View testID="board-look-active-badge" style={styles.activeBadge}>
            <Icon name="tick" size={11} color={overlays.onScrim} />
            <Text
              variant="caption2"
              color={overlays.onScrim}
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            >
              {t('mobile.more.boardLook.presets.activeBadge')}
            </Text>
          </View>
        ) : null}
        {selected ? (
          <View testID="board-look-expand-badge" style={styles.expandBadge}>
            <Icon name="expand" size={11} color={overlays.onScrim} />
          </View>
        ) : null}
      </View>

      <Text variant="subheadline" numberOfLines={TITLE_LINES} style={styles.title}>
        {label}
      </Text>
      <Text
        variant="caption1"
        color={systemColors.secondaryLabel}
        numberOfLines={DESCRIPTION_LINES}
        style={{ minHeight: DESCRIPTION_LINES * descriptionLineHeight }}
      >
        {description}
      </Text>
    </AnimatedPressable>
  );
});

const styles = StyleSheet.create({
  container: {
    width: BOARD_LOOK_CARD_WIDTH,
  },
  thumb: {
    width: BOARD_LOOK_CARD_WIDTH,
    height: BOARD_LOOK_CARD_WIDTH,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    // Constant, so selecting a card never relayouts the board image inside it.
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
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.82,
  },
  // Mirrors activeBadge on the other corner: the selected card is the one you
  // can open big, and without a mark nothing says so — its press just looks like
  // a re-pick of the look you already have.
  expandBadge: {
    position: 'absolute',
    bottom: spacing[2],
    right: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[1],
    borderRadius: borderRadius.full,
    backgroundColor: overlays.scrim,
  },
  activeBadge: {
    position: 'absolute',
    bottom: spacing[2],
    left: spacing[2],
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
    backgroundColor: overlays.scrim,
  },
  title: {
    fontWeight: '600',
  },
});
