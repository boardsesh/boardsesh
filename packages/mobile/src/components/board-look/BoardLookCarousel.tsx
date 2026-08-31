import { useCallback, useEffect, useMemo, useRef } from 'react';
import { PixelRatio, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SnapCarousel } from '../SnapCarousel';
import { BoardLookPreviewCard, type BoardLookCardLayout } from './BoardLookPreviewCard';
import { BoardPreviewSheet } from './BoardPreviewSheet';
import { useEnlargedPreview } from './use-enlarged-preview';
import { useBoardRenderSettings } from '../../lib/board-render-settings';
import { ensureBoardseshSupportProbed } from '../../hooks/use-native-climb-render';
import {
  buildBoardLookPreviewSettings,
  type BoardLookOption,
  type BoardLookOptionId,
} from '../../lib/board-render/board-look-options';
import type { BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import { RAIL_RENDER_WIDTH, RAIL_THUMB_HEIGHT, quantizeRenderWidth, railThumbWidth } from './board-look-card-metrics';

type BoardLookCarouselProps = {
  options: readonly BoardLookOption[];
  selectedId: BoardLookOptionId;
  onSelect: (id: BoardLookOptionId) => void;
  preview: BoardPreviewSource;
  /**
   * `null` — the capability probe has not answered, so every card that needs the
   * Boardsesh renderer shows a skeleton rather than a classic render under a
   * Boardsesh label. `false` — the caller should already have filtered those
   * cards out; they are skeletoned defensively rather than allowed to lie.
   */
  boardseshRendererAvailable: boolean | null;
  /**
   * Fired the first time a card scrolls into view, so a caller can tell "picked
   * the default on sight" apart from "swiped through and then picked it".
   * Optional — the settings screen has no funnel to feed.
   */
  onCardSeen?: (id: BoardLookOptionId) => void;
  /**
   * Draw the cards at hero size, centred, with the neighbours de-emphasised.
   * Resolved by the host, which is the only thing that can measure the slot.
   */
  heroThumb?: { width: number; height: number } | null;
  /** Window width. Only needed alongside `heroThumb`, to centre the rail. */
  windowWidth?: number;
  /**
   * Let a flick choose the card it lands on.
   *
   * Onboarding only, and off by default for a reason: in settings `onSelect`
   * writes immediately and reaches the physical board's LEDs, so a swipe there
   * would fire one write per card scrolled past.
   */
  selectOnSnap?: boolean;
  contentStyle?: ViewStyle;
};

/** A card counts as seen once most of it is on screen. */
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 60 } as const;

/**
 * The horizontal board-look picker, shared by the one-time onboarding step and
 * the Board look settings screen — so the two can never drift on what the
 * options are, what they preview, or what picking one does.
 *
 * Every card draws the SAME climb on the climber's own board, differing only in
 * render settings, so the bundled board photo decodes once and the cards differ
 * by a small holds-only overlay each. FlashList virtualizes, so a rail of six
 * costs about three native renders.
 */
export function BoardLookCarousel({
  options,
  selectedId,
  onSelect,
  preview,
  boardseshRendererAvailable,
  onCardSeen,
  heroThumb,
  windowWidth,
  selectOnSnap,
  contentStyle,
}: BoardLookCarouselProps) {
  const { t } = useTranslation('common');
  const { settings } = useBoardRenderSettings();
  const enlarged = useEnlargedPreview<BoardLookOptionId>();

  // Force the capability probe. The render path only asks the native library
  // whether it can draw the Boardsesh mode when the climber's own mode ALREADY
  // requests it — so a climber sitting on Classic never probes, the answer stays
  // `null`, and every Boardsesh card here renders a skeleton forever. This
  // carousel exists to preview the mode they are NOT on, so it has to ask.
  // Callers read the answer through `useEffectiveBoardRenderSettings`, which
  // subscribes to the same latch and re-renders when it lands.
  useEffect(() => {
    ensureBoardseshSupportProbed();
  }, []);

  // Memoized because these identities become `renderSettingsOverride` on a
  // memoized image: a fresh map per render would re-fire every card's overlay
  // effect on every tick.
  const previewSettingsById = useMemo(() => buildBoardLookPreviewSettings(options, settings), [options, settings]);

  const layout = useMemo<BoardLookCardLayout>(() => {
    const aspect = preview.boardWidth / preview.boardHeight;
    if (heroThumb) {
      return {
        size: 'hero',
        thumbWidth: heroThumb.width,
        thumbHeight: heroThumb.height,
        // A hero draws the wall two to three times wider than a rail thumb, so it
        // needs its own rung of the raster ladder. Quantized and clamped, so the
        // whole fleet shares a couple of cache entries rather than minting a PNG
        // per device width.
        renderWidth: quantizeRenderWidth(heroThumb.width, PixelRatio.get(), preview.boardWidth),
        // The 416px bundled thumb photo would upscale ~2x here, and the wall
        // texture is precisely what a climber is being asked to judge.
        backgroundVariant: 'full',
      };
    }
    return {
      size: 'rail',
      thumbWidth: railThumbWidth(aspect),
      thumbHeight: RAIL_THUMB_HEIGHT,
      renderWidth: RAIL_RENDER_WIDTH,
      backgroundVariant: 'thumb',
    };
  }, [heroThumb, preview.boardWidth, preview.boardHeight]);

  // Held in a ref and read through a stable handler: a list's
  // onViewableItemsChanged identity must not change between renders.
  const onCardSeenRef = useRef(onCardSeen);
  onCardSeenRef.current = onCardSeen;
  const handleViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: { key: string }[] }) => {
    const report = onCardSeenRef.current;
    if (!report) return;
    for (const entry of viewableItems) report(entry.key as BoardLookOptionId);
  }, []);

  // EVERY mutable value `renderItem` closes over. FlashList recycles rows and
  // will not re-render an unchanged item just because `renderItem` got a new
  // identity, so anything missing here goes stale on screen.
  //
  // `previewSettingsById` is the subtle one: switching Role glyphs on while the
  // current bundle still matches a preset changes every card's override without
  // touching `selectedId`, and the mounted cards would keep drawing the old
  // ones — the exact opposite of the promise the carousel makes, which is that
  // a card shows what applying it would produce.
  //
  // `layout` joined it when the cards stopped being a fixed 168pt square: it
  // changes when the slot is measured, and a recycled row would otherwise keep
  // the size it first mounted at.
  const extraData = useMemo(
    () => ({ selectedId, boardseshRendererAvailable, previewSettingsById, layout }),
    [selectedId, boardseshRendererAvailable, previewSettingsById, layout],
  );

  const handleEnlarge = useCallback((id: BoardLookOptionId) => enlarged.open(id), [enlarged]);

  const selectedIndex = useMemo(
    () =>
      Math.max(
        0,
        options.findIndex((option) => option.id === selectedId),
      ),
    [options, selectedId],
  );

  // Held in a ref so the snap handler stays stable across renders — it lands on
  // the list, whose scroll callbacks should not churn identity mid-gesture.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const handleSnapToIndex = useCallback((index: number) => {
    const option = optionsRef.current[index];
    if (option) onSelectRef.current(option.id);
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: BoardLookOption; index: number }) => (
      <BoardLookPreviewCard
        option={item}
        preview={preview}
        layout={layout}
        renderSettingsOverride={previewSettingsById.get(item.id)}
        selected={item.id === selectedId}
        index={index}
        total={options.length}
        showSkeleton={item.requiresBoardseshRenderer && boardseshRendererAvailable !== true}
        onPress={onSelect}
        onEnlarge={handleEnlarge}
      />
    ),
    [preview, previewSettingsById, selectedId, boardseshRendererAvailable, onSelect, handleEnlarge, layout, options],
  );

  const enlargedOption = enlarged.contentId ? options.find((option) => option.id === enlarged.contentId) : undefined;

  return (
    <>
      <SnapCarousel
        data={options}
        cardWidth={layout.thumbWidth}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        // Both values `renderItem` closes over that FlashList cannot see for
        // itself. Without the capability latch here, cards that mounted as
        // skeletons while the probe was unanswered would stay skeletons after it
        // answers — a recycled row is not re-rendered just because `renderItem`
        // changed identity.
        extraData={extraData}
        align={heroThumb ? 'center' : 'start'}
        windowWidth={windowWidth}
        initialScrollIndex={selectedIndex}
        // Tapping a neighbour that is only peeking in makes it the chosen look;
        // bringing it to the centre is what keeps "the card you are looking at"
        // and "the look the button will apply" the same card.
        activeIndex={heroThumb ? selectedIndex : undefined}
        // One offscreen card at hero size. Each live card holds a multi-megabyte
        // bitmap, and this screen fires on a cold first launch right after a sync.
        drawDistance={heroThumb ? layout.thumbWidth : undefined}
        onSnapToIndex={selectOnSnap ? handleSnapToIndex : undefined}
        viewabilityConfig={VIEWABILITY_CONFIG}
        onViewableItemsChanged={handleViewableItemsChanged}
        accessibilityLabel={t('mobile.more.boardLook.presets.carouselAccessibility')}
        contentStyle={contentStyle}
      />

      <BoardPreviewSheet
        visible={enlarged.visibleId != null}
        title={enlargedOption ? t(enlargedOption.labelI18nKey) : null}
        subtitle={enlargedOption ? t(enlargedOption.descriptionI18nKey) : undefined}
        preview={preview}
        renderSettingsOverride={enlargedOption ? previewSettingsById.get(enlargedOption.id) : undefined}
        // The same rung the cards are on, so enlarging reuses the render they
        // already paid for rather than minting a second one at a second size.
        renderWidth={layout.renderWidth}
        backgroundVariant={layout.backgroundVariant}
        recyclingKey={enlarged.contentId ?? undefined}
        onClose={enlarged.close}
        onFullyDismissed={enlarged.handleFullyDismissed}
      />
    </>
  );
}

function keyExtractor(option: BoardLookOption) {
  return option.id;
}
