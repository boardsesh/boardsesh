import { useCallback, useMemo } from 'react';
import { type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SnapCarousel } from '../SnapCarousel';
import { PALETTE_CARD_WIDTH, PalettePreviewCard } from './PalettePreviewCard';
import { BoardPreviewSheet } from './BoardPreviewSheet';
import { useEnlargedPreview } from './use-enlarged-preview';
import {
  CVD_PALETTE_OPTIONS,
  type CvdPaletteOption,
  type CvdPaletteOptionId,
} from '../../lib/board-render/cvd-palette-options';
import type { BoardPreviewSource } from '../../hooks/use-board-preview-climb';

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
  const enlarged = useEnlargedPreview<CvdPaletteOptionId>();

  // EVERY mutable value `renderItem` closes over. FlashList recycles rows and
  // will not re-render an unchanged item just because `renderItem` got a new
  // identity, so anything missing here goes stale on screen — including the
  // Custom card, whose preview follows the store and changes the moment the
  // climber edits a colour.
  const extraData = useMemo(() => ({ selectedId, preview }), [selectedId, preview]);

  // Pressing a palette you are not on applies it. Pressing the one you ARE on
  // has nothing left to apply, so it opens the preview big instead — 168pt is
  // too small to judge two marker colours against each other, which is the whole
  // job this screen exists for.
  const handlePress = useCallback(
    (id: CvdPaletteOptionId) => {
      if (id === selectedId) {
        enlarged.open(id);
        return;
      }
      onSelect(id);
    },
    [selectedId, onSelect, enlarged],
  );

  const renderItem = useCallback(
    ({ item }: { item: CvdPaletteOption }) => (
      <PalettePreviewCard option={item} preview={preview} selected={item.id === selectedId} onPress={handlePress} />
    ),
    [preview, selectedId, handlePress],
  );

  const enlargedOption = enlarged.contentId
    ? CVD_PALETTE_OPTIONS.find((option) => option.id === enlarged.contentId)
    : undefined;

  return (
    <>
      <SnapCarousel
        data={CVD_PALETTE_OPTIONS}
        cardWidth={PALETTE_CARD_WIDTH}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        extraData={extraData}
        accessibilityLabel={t('mobile.more.accessibility.palettes.carouselAccessibility')}
        contentStyle={contentStyle}
      />

      <BoardPreviewSheet
        visible={enlarged.visibleId != null}
        title={enlargedOption ? t(enlargedOption.labelI18nKey) : null}
        subtitle={enlargedOption ? t(enlargedOption.descriptionI18nKey) : undefined}
        preview={preview}
        holdColorOverride={enlargedOption?.previewRoles}
        recyclingKey={enlarged.contentId ?? undefined}
        onClose={enlarged.close}
        onFullyDismissed={enlarged.handleFullyDismissed}
      />
    </>
  );
}

function keyExtractor(option: CvdPaletteOption) {
  return option.id;
}
