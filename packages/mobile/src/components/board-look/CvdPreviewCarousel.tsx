import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SnapCarousel } from '../SnapCarousel';
import { CVD_PREVIEW_CARD_WIDTH, CvdPreviewCard } from './CvdPreviewCard';
import { BoardPreviewSheet } from './BoardPreviewSheet';
import { useEnlargedPreview } from './use-enlarged-preview';
import { type BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import {
  CVD_PREVIEW_OPTIONS,
  type CvdPreviewOption,
  type CvdPreviewOptionId,
} from '../../lib/board-render/cvd-preview-options';
import { borderRadius, spacing } from '../../theme/tokens';

type CvdPreviewCarouselProps = {
  preview: BoardPreviewSource;
  contentStyle?: ViewStyle;
};

/** A card counts as seen once most of it is on screen. */
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 60 } as const;

/**
 * The first card is seen before anything scrolls.
 *
 * FlashList does report its initially-visible rows through
 * `onViewableItemsChanged`, but seeding the latch means the rail is never blank
 * if it doesn't — and "Normal" is the card that replaces the standalone Preview
 * section this rail absorbed, so it is the one that must always be there.
 */
const INITIALLY_SEEN: ReadonlySet<CvdPreviewOptionId> = new Set<CvdPreviewOptionId>([CVD_PREVIEW_OPTIONS[0].id]);

/**
 * The climber's own board, drawn four times: as it really is, then through
 * deuteranopia, protanopia and tritanopia.
 *
 * Replaces the four abstract colour swatches this screen used to answer "can I
 * still tell my hold roles apart?" with. The question is about a board, so the
 * answer is a board.
 *
 * A viewer, not a picker — no card is ever selected, and nothing here writes the
 * override store, so a simulation can never reach the physical board's LEDs.
 * Tapping a card opens it full size, because a 168pt thumbnail is too small to
 * judge two marker colours against each other, which is the whole job.
 *
 * Renders lazily: only cards that have scrolled into view mount a board. Four
 * simultaneous native renders is the real cost of this rail and only two cards
 * fit on a phone.
 */
export function CvdPreviewCarousel({ preview, contentStyle }: CvdPreviewCarouselProps) {
  const { t } = useTranslation('common');
  const [seenIds, setSeenIds] = useState<ReadonlySet<CvdPreviewOptionId>>(INITIALLY_SEEN);
  const enlarged = useEnlargedPreview<CvdPreviewOptionId>();

  // Identity must never change: a list's `onViewableItemsChanged` must not
  // change between renders. `setSeenIds` is stable, so the whole handler is.
  const handleViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: { key: string }[] }) => {
    setSeenIds((current) => {
      let next: Set<CvdPreviewOptionId> | null = null;
      for (const entry of viewableItems) {
        const id = entry.key as CvdPreviewOptionId;
        if (current.has(id)) continue;
        next ??= new Set(current);
        next.add(id);
      }
      // Once seen, never un-seen — scrolling a mounted board back off screen
      // must not throw its render away and re-pay for it on the way back.
      return next ?? current;
    });
  }, []);

  // EVERY mutable value `renderItem` closes over. FlashList recycles rows and
  // will not re-render an unchanged item just because `renderItem` got a new
  // identity, so a card that mounted as a skeleton would stay one forever if the
  // seen-latch only reached it through the closure.
  const extraData = useMemo(() => ({ seenIds, preview }), [seenIds, preview]);

  const renderItem = useCallback(
    ({ item }: { item: CvdPreviewOption }) => (
      <CvdPreviewCard option={item} preview={preview} showSkeleton={!seenIds.has(item.id)} onPress={enlarged.open} />
    ),
    [preview, seenIds, enlarged.open],
  );

  const enlargedOption = enlarged.contentId
    ? CVD_PREVIEW_OPTIONS.find((option) => option.id === enlarged.contentId)
    : undefined;

  return (
    <>
      <SnapCarousel
        data={CVD_PREVIEW_OPTIONS}
        cardWidth={CVD_PREVIEW_CARD_WIDTH}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        extraData={extraData}
        viewabilityConfig={VIEWABILITY_CONFIG}
        onViewableItemsChanged={handleViewableItemsChanged}
        accessibilityLabel={t('mobile.more.accessibility.cvd.carouselAccessibility')}
        contentStyle={contentStyle}
      />

      <BoardPreviewSheet
        visible={enlarged.visibleId != null}
        title={enlargedOption ? t(enlargedOption.titleI18nKey) : null}
        subtitle={enlargedOption ? t(enlargedOption.subtitleI18nKey) : undefined}
        note={t('mobile.more.accessibility.cvd.photoNote')}
        preview={preview}
        holdColorTransform={enlargedOption?.transform}
        holdColorTransformKey={enlargedOption?.transformKey}
        recyclingKey={enlarged.contentId ?? undefined}
        onClose={enlarged.close}
        onFullyDismissed={enlarged.handleFullyDismissed}
      />
    </>
  );
}

function keyExtractor(option: CvdPreviewOption) {
  return option.id;
}

const styles = StyleSheet.create({
  sheetBody: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    gap: spacing[2],
  },
  sheetBoard: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    marginTop: spacing[2],
  },
  sheetNote: {
    lineHeight: 18,
  },
});
