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
import type { CvdPaletteOption, CvdPaletteOptionId } from '../../lib/board-render/cvd-palette-options';
import { borderRadius, overlays, spacing } from '../../theme/tokens';
import { textStyles, CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';

/** Same 168pt square as the board-look preset rail, so the two rails read as one component. */
export const PALETTE_CARD_WIDTH = 168;

/** A palette's name is one word — "Default", "Tritanopia" — so it gets one line. */
const TITLE_LINES = 1;

/** The description is a sentence, so it gets two lines, reserved either way. */
const DESCRIPTION_LINES = 2;

/**
 * Total height of a card: the square thumb, the gap under it, the one-line name,
 * and the reserved two-line description.
 *
 * A constant rather than a measurement, for the same reason
 * `BOARD_LOOK_CARD_HEIGHT` is one: a host pinning a fixed-height row needs it
 * before anything has laid out. Safe in both UI variants — HIG and Material give
 * `subheadline` the same 20pt lineHeight and `caption1` the same 16pt one.
 */
export const PALETTE_CARD_HEIGHT =
  PALETTE_CARD_WIDTH +
  spacing[2] +
  TITLE_LINES * textStyles.subheadline.lineHeight +
  DESCRIPTION_LINES * textStyles.caption1.lineHeight;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type PalettePreviewCardProps = {
  option: CvdPaletteOption;
  preview: BoardPreviewSource;
  selected: boolean;
  onPress: (id: CvdPaletteOptionId) => void;
};

/**
 * One colour-vision palette, drawn on the climber's own board.
 *
 * Same anatomy as `BoardLookPreviewCard` — bare container, square bordered
 * thumb, Active pill bottom-left, expand badge bottom-right, one-line title over
 * a two-line caption — so the two rails on the Board look screens read as one
 * component.
 *
 * The colours are a PREVIEW only: they reach the render through
 * `holdColorOverride`, which never writes the override store, so a card the
 * climber only scrolls past cannot reach the physical board's LEDs. Pressing it
 * is what writes.
 *
 * Memoized, and `onPress` takes the option id, so the carousel's `renderItem`
 * needs no per-card closure and a selection change re-renders only the two cards
 * whose `selected` actually flipped.
 */
export const PalettePreviewCard = React.memo(function PalettePreviewCard({
  option,
  preview,
  selected,
  onPress,
}: PalettePreviewCardProps) {
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
  // agree on 16 today, but the reserved description box has to keep baselines
  // aligned in whichever one is active.
  const descriptionLineHeight = resolvedTextStyles.caption1.lineHeight ?? textStyles.caption1.lineHeight;

  // Colour only — the width is constant in `styles.thumb`. Every card draws the
  // SAME climb and selection changes on every tap, and the thumb letterboxes its
  // image, so a border-WIDTH change would resize that image on each tap (the
  // flicker fixed in 9e51e7394).
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
      // the palette you are on opens bigger, the others get applied.
      accessibilityHint={selected ? t('mobile.more.accessibility.cvd.openLarger') : undefined}
      onPress={handlePress}
      onPressIn={() => (scale.value = withSpring(0.97, springs.snappy))}
      onPressOut={() => (scale.value = withSpring(1, springs.snappy))}
      style={[animatedStyle, styles.container]}
    >
      <View testID="palette-thumb" style={[styles.thumb, thumbStyle]}>
        <BoardImageNative
          frames={preview.frames}
          boardName={preview.boardName}
          layoutId={preview.layoutId}
          sizeId={preview.sizeId}
          setIds={preview.setIds}
          boardWidth={preview.boardWidth}
          boardHeight={preview.boardHeight}
          renderWidth={BOARD_PREVIEW_RENDER_WIDTH}
          holdColorOverride={option.previewRoles}
          // Every card draws the SAME climb, so the palette is what identifies
          // this overlay. FlashList recycles rows, and without a key that changes
          // with the option a recycled view keeps showing the previous card's
          // overlay until the new one decodes.
          recyclingKey={option.id}
          // Letterboxed, NOT cropped: a board is taller than it is wide, and
          // filling a square would cut off the top and bottom holds. Judging all
          // four roles against each other is the entire point of this rail, so
          // dropping two rows of them would defeat it.
          style={styles.boardImage}
        />

        {selected ? (
          <View testID="palette-active-badge" style={styles.activeBadge}>
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
          <View testID="palette-expand-badge" style={styles.expandBadge}>
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
    width: PALETTE_CARD_WIDTH,
  },
  thumb: {
    width: PALETTE_CARD_WIDTH,
    height: PALETTE_CARD_WIDTH,
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
  // Mirrors activeBadge on the other corner: the selected card is the one you
  // can open big, and without a mark nothing says so — its press just looks like
  // a re-apply of the palette you already have.
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
