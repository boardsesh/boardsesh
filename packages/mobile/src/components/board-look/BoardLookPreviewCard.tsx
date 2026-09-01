import React, { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { BoardImageNative } from '../BoardImageNative';
import { useTheme } from '../../providers/theme-provider';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { useReduceTransparency } from '../../hooks/use-reduce-transparency';
import { hapticLight } from '../../lib/haptics';
import { springs } from '../../theme/animations';
import { type BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import type { BoardLookOption, BoardLookOptionId } from '../../lib/board-render/board-look-options';
import type { BoardRenderSettings } from '../../lib/board-render-settings';
import type { BackgroundVariant } from '../../lib/background-image-cache';
import { borderRadius, opacity as opacityTokens, overlays, spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { cardSizeStyle, descriptionMinHeight, type BoardLookCardSize } from './board-look-card-metrics';

/** Where a card is drawn. Resolved by the carousel and handed down. */
export type BoardLookCardLayout = {
  size: BoardLookCardSize;
  thumbWidth: number;
  thumbHeight: number;
  /** Rasterization width for the Rust renderer, already quantized and clamped. */
  renderWidth: number;
  /**
   * `'full'` on a hero. The 416pt bundled thumb photo upscales ~2x at hero size,
   * and the wall texture is exactly what "lit holds glow on a quietened wall"
   * asks the climber to judge. Nearly free: the photo is cached per board config
   * rather than per climb, so every card in the rail shares one decode.
   */
  backgroundVariant: BackgroundVariant;
  /**
   * Whether the caption carries the option's one-line description.
   *
   * Off in the onboarding step: six cards each restating what the picture is
   * already showing is copy the climber has to read past to get to the board,
   * and the freed height goes to the hero instead. The settings rail keeps it —
   * there the thumb is small and the sentence is doing real work.
   */
  showDescription: boolean;
};

type BoardLookPreviewCardProps = {
  option: BoardLookOption;
  preview: BoardPreviewSource;
  layout: BoardLookCardLayout;
  /**
   * The bundle this card draws under, or `undefined` to draw the climber's own
   * stored settings (the settings screen's Custom card). Comes from
   * `buildBoardLookPreviewSettings`, which must be memoized — this prop lands on
   * a `React.memo`'d image whose overlay effect re-fires on identity change.
   */
  renderSettingsOverride: BoardRenderSettings | undefined;
  selected: boolean;
  /** Position in the rail, for the assistive-tech "3 of 5" announcement. */
  index: number;
  total: number;
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
  /** Open this look full size. Reachable on EVERY card, not just the chosen one. */
  onEnlarge: (id: BoardLookOptionId) => void;
};

/**
 * One board look, drawn on the climber's own board.
 *
 * Same anatomy at both sizes — bordered thumb, one-line name over a reserved
 * two-line caption, an expand control bottom-right — so the onboarding hero and
 * the two settings rails read as one component at two scales rather than as two
 * components.
 *
 * **The card is the shape of the board.** The thumb takes the board's own aspect
 * instead of being a square with the picture letterboxed inside it, so
 * `BoardImageNative`'s own `aspectRatio` fills the frame exactly and none of the
 * wall is traded for black bars.
 *
 * Memoized, and every handler takes the option id, so the carousel's `renderItem`
 * needs no per-card closure and a selection change re-renders only the two cards
 * whose `selected` actually flipped.
 */
export const BoardLookPreviewCard = React.memo(function BoardLookPreviewCard({
  option,
  preview,
  layout,
  renderSettingsOverride,
  selected,
  index,
  total,
  showSkeleton,
  onPress,
  onEnlarge,
}: BoardLookPreviewCardProps) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors, textStyles: resolvedTextStyles } = useTheme();
  const { fontScale } = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const reduceTransparency = useReduceTransparency();

  const style = cardSizeStyle(layout.size);

  // De-emphasising the neighbours is what makes the chosen card read at hero
  // scale: a 3pt border is 1% of a 306pt card, but a dimmer, slightly smaller
  // neighbour is legible in peripheral vision with no chrome at all.
  //
  // Driven by SELECTION, not by scroll offset. A scroll-linked transform would
  // re-composite a multi-megabyte board bitmap every frame; this is one spring
  // when the choice changes.
  const dimmed = style.dimUnselected && !selected;
  const emphasis = useSharedValue(dimmed ? 0 : 1);
  emphasis.value = reduceMotion ? (dimmed ? 0 : 1) : withSpring(dimmed ? 0 : 1, springs.snappy);
  const emphasisStyle = useAnimatedStyle(() => ({
    opacity: opacityTokens.peek + (1 - opacityTokens.peek) * emphasis.value,
    // Transform only — never a layout width change, or the rail's snap interval
    // stops matching the cards it is snapping to.
    transform: [{ scale: style.dimScale + (1 - style.dimScale) * emphasis.value }],
  }));

  const handlePress = useCallback(() => {
    hapticLight();
    onPress(option.id);
  }, [onPress, option.id]);

  const handleEnlarge = useCallback(() => {
    hapticLight();
    onEnlarge(option.id);
  }, [onEnlarge, option.id]);

  const label = t(option.labelI18nKey);
  const descriptionLineHeight = resolvedTextStyles[style.descriptionVariant].lineHeight ?? 16;

  // Colour only — the width is constant in `thumbStyle`. Every card draws the
  // SAME climb and selection changes on every tap, so a border-WIDTH change would
  // resize the picture inside on each tap (the flicker fixed in 9e51e7394).
  const thumbStyle = {
    width: layout.thumbWidth,
    height: layout.thumbHeight,
    borderWidth: style.borderWidth,
    backgroundColor: systemColors.tertiaryBackground,
    borderColor: selected ? brandColors.primary : systemColors.separator,
  };

  // The feature this screen is selling is "lit holds glow", so the chosen card
  // glowing is the product quoting itself rather than decoration. Reduce
  // Transparency means "do not composite chrome over content" — drop it there.
  const halo =
    selected && style.halo && !reduceTransparency
      ? {
          shadowColor: brandColors.primary as string,
          shadowOpacity: 0.35,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 4 },
          elevation: 8,
        }
      : undefined;

  // Opaque under Reduce Transparency: the setting is about compositing, not about
  // contrast, and these sit directly on the board art.
  const scrimColor = reduceTransparency ? (systemColors.background as string) : overlays.scrim;
  const scrimLabel = reduceTransparency ? (systemColors.label as string) : overlays.onScrim;

  const enlargeActions = useMemo(
    () => [{ name: 'longpress' as const, label: t('mobile.more.accessibility.cvd.openLarger') }],
    [t],
  );

  return (
    <Animated.View style={[styles.container, emphasisStyle, { width: layout.thumbWidth }]}>
      <PressableSurface
        // A mutually-exclusive picker of a handful of options. `button` +
        // `selected` announces "selected" but conveys neither the exclusivity nor
        // the position — the information a non-visual climber needs most on a
        // step that has no exit.
        accessibilityRole="radio"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={label}
        accessibilityValue={{ text: t('mobile.more.boardLook.presets.position', { index: index + 1, total }) }}
        accessibilityActions={enlargeActions}
        onAccessibilityAction={handleEnlarge}
        onPress={handlePress}
        onLongPress={handleEnlarge}
        // The press travel has to stay roughly constant in POINTS as the card
        // grows: 3% of a 168pt rail card is 5pt, but 3% of a 306pt hero would be
        // 9pt of unrequested movement on a screen nobody can leave.
        feedback={reduceMotion ? 'none' : 'scale'}
        scaleTo={style.pressScale}
      >
        <View testID="board-look-thumb" style={[styles.thumb, thumbStyle, halo]}>
          {showSkeleton ? (
            <View testID="board-look-skeleton" style={[styles.fill, { backgroundColor: systemColors.fill }]} />
          ) : (
            <BoardImageNative
              frames={preview.frames}
              boardName={preview.boardName}
              layoutId={preview.layoutId}
              sizeId={preview.sizeId}
              setIds={preview.setIds}
              boardWidth={preview.boardWidth}
              boardHeight={preview.boardHeight}
              renderWidth={layout.renderWidth}
              backgroundVariant={layout.backgroundVariant}
              renderSettingsOverride={renderSettingsOverride}
              // Every card draws the SAME climb, so the option is what identifies
              // this overlay. FlashList recycles rows, and without a key that
              // changes with the option a recycled view keeps showing the previous
              // card's overlay until the new one decodes.
              recyclingKey={option.id}
              // The thumb IS the board's aspect now, so the image fills it and
              // there is nothing left to letterbox.
              style={styles.fill}
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
              style={[
                StyleSheet.absoluteFill,
                styles.placeholder,
                {
                  backgroundColor: systemColors.secondaryBackground,
                  // A translucent veil over content is the clearest thing on this
                  // screen for Reduce Transparency to switch off.
                  opacity: reduceTransparency ? 1 : 0.82,
                },
              ]}
            >
              <Text variant="largeTitle" color={systemColors.label}>
                ?
              </Text>
            </View>
          ) : null}

          {/* "This is the look you're on" reads as a word rather than a bare tick,
              the same way the active board does on the discovery rail. The hero
              hides it: in onboarding nothing is applied until the footer button is
              pressed, so "Active" would be false — and the pill would sit on the
              holds the climber is finally big enough to compare. */}
          {selected && style.showActiveBadge ? (
            <View testID="board-look-active-badge" style={[styles.activeBadge, { backgroundColor: scrimColor }]}>
              <Icon name="tick" size={11} color={scrimLabel} />
              <Text
                variant="caption2"
                color={scrimLabel}
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
              >
                {t('mobile.more.boardLook.presets.activeBadge')}
              </Text>
            </View>
          ) : null}

          {/* A real button, on every card. It used to be an inert View on the
              selected card only — invisible to assistive tech, a 19pt target, and
              absent from exactly the card you most want a closer look at: one you
              have not chosen yet. */}
          <Pressable
            testID="board-look-expand-badge"
            accessibilityRole="button"
            accessibilityLabel={t('mobile.more.boardLook.presets.showFullSize', { look: label })}
            onPress={handleEnlarge}
            hitSlop={style.expandHitSlop}
            style={[
              styles.expandBadge,
              { width: style.expandSize, height: style.expandSize, backgroundColor: scrimColor },
            ]}
          >
            <Icon name="expand" size={style.expandIcon} color={scrimLabel} />
          </Pressable>
        </View>

        {/* `alignSelf: 'stretch'` is what makes the centring work: the container
            is `alignItems: 'flex-start'`, which shrinks the Text to its content
            and leaves `textAlign` with nothing to centre inside. */}
        <Text
          variant={style.titleVariant}
          numberOfLines={1}
          style={[styles.title, layout.showDescription ? null : styles.titleCentered]}
        >
          {label}
        </Text>
        {layout.showDescription ? (
          <Text
            variant={style.descriptionVariant}
            color={systemColors.secondaryLabel}
            numberOfLines={2}
            // Reserved so every card in the rail keeps its bottom edge on one
            // baseline. Scaled by the text size, because React Native scales
            // lineHeight by the font multiplier — a reservation computed from the
            // unscaled value silently goes inert above fontScale 1.
            style={{ minHeight: descriptionMinHeight(descriptionLineHeight, fontScale) }}
          >
            {t(option.descriptionI18nKey)}
          </Text>
        ) : null}
      </PressableSurface>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  container: {
    alignItems: 'flex-start',
  },
  thumb: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing[2],
  },
  fill: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  expandBadge: {
    position: 'absolute',
    bottom: spacing[2],
    right: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.full,
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
  },
  title: {
    fontWeight: '600',
  },
  titleCentered: {
    alignSelf: 'stretch',
    textAlign: 'center',
  },
});
