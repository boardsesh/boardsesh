import React, { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { BoardImageNative } from '../BoardImageNative';
import { useTheme } from '../../providers/theme-provider';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { useReduceTransparency } from '../../hooks/use-reduce-transparency';
import { hapticLight } from '../../lib/haptics';
import type { BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import type { CvdPaletteOption, CvdPaletteOptionId } from '../../lib/board-render/cvd-palette-options';
import { borderRadius, overlays, spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import {
  RAIL_RENDER_WIDTH,
  RAIL_THUMB_HEIGHT,
  cardSizeStyle,
  descriptionMinHeight,
  railThumbWidth,
} from './board-look-card-metrics';

type PalettePreviewCardProps = {
  option: CvdPaletteOption;
  preview: BoardPreviewSource;
  selected: boolean;
  index: number;
  total: number;
  onPress: (id: CvdPaletteOptionId) => void;
  onEnlarge: (id: CvdPaletteOptionId) => void;
};

/**
 * One colour-vision palette, drawn on the climber's own board.
 *
 * Same anatomy as `BoardLookPreviewCard` and the same geometry from the same
 * resolver — board-shaped thumb pinned to `RAIL_THUMB_HEIGHT`, Active pill
 * bottom-left, expand control bottom-right, one-line title over a two-line
 * caption — so the two rails on the Board look screens read as one component.
 *
 * **This rail never de-emphasises an unselected card.** The whole job here is
 * judging whether two marker colours stay apart; a neighbour at 0.62 alpha would
 * make that judgement wrong. Dimming belongs to the board-look hero, where every
 * card carries the same colours and differs only in the drawing.
 *
 * The colours are a PREVIEW only: they reach the render through
 * `holdColorOverride`, which never writes the override store, so a card the
 * climber only scrolls past cannot reach the physical board's LEDs. Pressing it
 * is what writes.
 */
export const PalettePreviewCard = React.memo(function PalettePreviewCard({
  option,
  preview,
  selected,
  index,
  total,
  onPress,
  onEnlarge,
}: PalettePreviewCardProps) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors, textStyles: resolvedTextStyles } = useTheme();
  const { fontScale } = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const reduceTransparency = useReduceTransparency();

  const style = cardSizeStyle('rail');
  const thumbWidth = railThumbWidth(preview.boardWidth / preview.boardHeight);

  const handlePress = useCallback(() => {
    hapticLight();
    onPress(option.id);
  }, [onPress, option.id]);

  const handleEnlarge = useCallback(() => {
    hapticLight();
    onEnlarge(option.id);
  }, [onEnlarge, option.id]);

  const label = t(option.labelI18nKey);
  const description = t(option.descriptionI18nKey);
  const descriptionLineHeight = resolvedTextStyles[style.descriptionVariant].lineHeight ?? 16;

  // Colour only — the width is constant. Every card draws the SAME climb and
  // selection changes on every tap, so a border-WIDTH change would resize the
  // picture inside on each tap (the flicker fixed in 9e51e7394).
  const thumbStyle = {
    width: thumbWidth,
    height: RAIL_THUMB_HEIGHT,
    borderWidth: style.borderWidth,
    backgroundColor: systemColors.tertiaryBackground,
    borderColor: selected ? brandColors.primary : systemColors.separator,
  };

  const scrimColor = reduceTransparency ? (systemColors.background as string) : overlays.scrim;
  const scrimLabel = reduceTransparency ? (systemColors.label as string) : overlays.onScrim;

  const enlargeActions = useMemo(
    () => [{ name: 'longpress' as const, label: t('mobile.more.accessibility.cvd.openLarger') }],
    [t],
  );

  return (
    <View style={[styles.container, { width: thumbWidth }]}>
      <PressableSurface
        accessibilityRole="radio"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={label}
        accessibilityValue={{ text: t('mobile.more.boardLook.presets.position', { index: index + 1, total }) }}
        accessibilityActions={enlargeActions}
        onAccessibilityAction={handleEnlarge}
        onPress={handlePress}
        onLongPress={handleEnlarge}
        feedback={reduceMotion ? 'none' : 'scale'}
        scaleTo={style.pressScale}
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
            renderWidth={RAIL_RENDER_WIDTH}
            holdColorOverride={option.previewRoles}
            // Every card draws the SAME climb, so the palette is what identifies
            // this overlay. FlashList recycles rows, and without a key that changes
            // with the option a recycled view keeps showing the previous card's
            // overlay until the new one decodes.
            recyclingKey={option.id}
            // The thumb IS the board's aspect now, so the image fills it. Judging
            // all four roles against each other is the entire point of this rail,
            // and none of them is cropped away.
            style={styles.fill}
          />

          {selected ? (
            <View testID="palette-active-badge" style={[styles.activeBadge, { backgroundColor: scrimColor }]}>
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

          <Pressable
            testID="palette-expand-badge"
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

        <Text variant={style.titleVariant} numberOfLines={1} style={styles.title}>
          {label}
        </Text>
        <Text
          variant={style.descriptionVariant}
          color={systemColors.secondaryLabel}
          numberOfLines={2}
          style={{ minHeight: descriptionMinHeight(descriptionLineHeight, fontScale) }}
        >
          {description}
        </Text>
      </PressableSurface>
    </View>
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
});
