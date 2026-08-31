import { useCallback, useMemo } from 'react';
import { type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SnapCarousel } from '../SnapCarousel';
import { PalettePreviewCard } from './PalettePreviewCard';
import { BoardPreviewSheet } from './BoardPreviewSheet';
import { useEnlargedPreview } from './use-enlarged-preview';
import {
  CVD_PALETTE_OPTIONS,
  type CvdPaletteOption,
  type CvdPaletteOptionId,
} from '../../lib/board-render/cvd-palette-options';
import type { BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import { RAIL_RENDER_WIDTH, railThumbWidth } from './board-look-card-metrics';

type PaletteCarouselProps = {
  preview: BoardPreviewSource;
  selectedId: CvdPaletteOptionId;
  onSelect: (id: CvdPaletteOptionId) => void;
  contentStyle?: ViewStyle;
};

/**
 * The colour-vision palette picker: the climber's own board drawn five times,
 * once under each palette they can put on it.
 *
 * Replaces the rail of dichromacy SIMULATIONS this screen used to open with. A
 * simulation is a tool for a sighted person auditing their setup; a colour-blind
 * climber needs palettes that stay apart, and a way to apply one. So the cards
 * are a picker now, and pressing one writes the four role colours — which is the
 * same path a manual colour pick takes, so it reaches the physical board's LEDs
 * too.
 *
 * Every card draws the SAME climb on the climber's own board, differing only in
 * hold colours, so the bundled board photo decodes once and the cards differ by
 * a small holds-only overlay each. FlashList virtualizes, so a rail of five costs
 * about three native renders.
 */
export function PaletteCarousel({ preview, selectedId, onSelect, contentStyle }: PaletteCarouselProps) {
  const { t } = useTranslation('common');
  // Destructured, not held as one object: the hook returns a fresh literal every
  // render, so depending on the object would hand `renderItem` a new identity on
  // every render, bail `React.memo` on every card, and re-render a board image
  // per card. The three callbacks inside it are stable.
  const {
    visibleId: enlargedVisibleId,
    contentId: enlargedContentId,
    open: openEnlarged,
    close: closeEnlarged,
    handleFullyDismissed: handleEnlargedDismissed,
  } = useEnlargedPreview<CvdPaletteOptionId>();

  // EVERY mutable value `renderItem` closes over. FlashList recycles rows and
  // will not re-render an unchanged item just because `renderItem` got a new
  // identity, so anything missing here goes stale on screen — including the
  // Custom card, whose preview follows the store and changes the moment the
  // climber edits a colour.
  const extraData = useMemo(() => ({ selectedId, preview }), [selectedId, preview]);

  // Enlarging is its own control on every card now, rather than a second meaning
  // for pressing the one you are already on. A rail thumb is too small to judge
  // two marker colours against each other — the whole job this screen exists for
  // — and the card you most need to check is usually one you have NOT applied.
  const renderItem = useCallback(
    ({ item, index }: { item: CvdPaletteOption; index: number }) => (
      <PalettePreviewCard
        option={item}
        preview={preview}
        selected={item.id === selectedId}
        index={index}
        total={CVD_PALETTE_OPTIONS.length}
        onPress={onSelect}
        onEnlarge={openEnlarged}
      />
    ),
    [preview, selectedId, onSelect, openEnlarged],
  );

  const enlargedOption = enlargedContentId
    ? CVD_PALETTE_OPTIONS.find((option) => option.id === enlargedContentId)
    : undefined;

  return (
    <>
      <SnapCarousel
        data={CVD_PALETTE_OPTIONS}
        cardWidth={railThumbWidth(preview.boardWidth / preview.boardHeight)}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        extraData={extraData}
        accessibilityLabel={t('mobile.more.accessibility.palettes.carouselAccessibility')}
        contentStyle={contentStyle}
      />

      <BoardPreviewSheet
        visible={enlargedVisibleId != null}
        title={enlargedOption ? t(enlargedOption.labelI18nKey) : null}
        subtitle={enlargedOption ? t(enlargedOption.descriptionI18nKey) : undefined}
        preview={preview}
        holdColorOverride={enlargedOption?.previewRoles}
        // The rung this rail's own cards are on, so enlarging reuses their render.
        renderWidth={RAIL_RENDER_WIDTH}
        backgroundVariant="thumb"
        recyclingKey={enlargedContentId ?? undefined}
        onClose={closeEnlarged}
        onFullyDismissed={handleEnlargedDismissed}
      />
    </>
  );
}

function keyExtractor(option: CvdPaletteOption) {
  return option.id;
}
