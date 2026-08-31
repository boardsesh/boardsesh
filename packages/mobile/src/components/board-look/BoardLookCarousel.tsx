import { useCallback, useEffect, useMemo, useRef } from 'react';
import { type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SnapCarousel } from '../SnapCarousel';
import { BOARD_LOOK_CARD_WIDTH, BoardLookPreviewCard } from './BoardLookPreviewCard';
import { useBoardRenderSettings } from '../../lib/board-render-settings';
import { ensureBoardseshSupportProbed } from '../../hooks/use-native-climb-render';
import {
  buildBoardLookPreviewSettings,
  type BoardLookOption,
  type BoardLookOptionId,
} from '../../lib/board-render/board-look-options';
import type { BoardPreviewSource } from '../../hooks/use-board-preview-climb';

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
 * by a small holds-only overlay each. FlashList virtualizes, so a carousel of
 * six costs about three native renders.
 */
export function BoardLookCarousel({
  options,
  selectedId,
  onSelect,
  preview,
  boardseshRendererAvailable,
  onCardSeen,
  contentStyle,
}: BoardLookCarouselProps) {
  const { t } = useTranslation('common');
  const { settings } = useBoardRenderSettings();

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
  const extraData = useMemo(
    () => ({ selectedId, boardseshRendererAvailable, previewSettingsById }),
    [selectedId, boardseshRendererAvailable, previewSettingsById],
  );

  const renderItem = useCallback(
    ({ item }: { item: BoardLookOption }) => (
      <BoardLookPreviewCard
        option={item}
        preview={preview}
        renderSettingsOverride={previewSettingsById.get(item.id)}
        selected={item.id === selectedId}
        showSkeleton={item.requiresBoardseshRenderer && boardseshRendererAvailable !== true}
        onPress={onSelect}
      />
    ),
    [preview, previewSettingsById, selectedId, boardseshRendererAvailable, onSelect],
  );

  return (
    <SnapCarousel
      data={options}
      cardWidth={BOARD_LOOK_CARD_WIDTH}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      // Both values `renderItem` closes over that FlashList cannot see for
      // itself. Without the capability latch here, cards that mounted as
      // skeletons while the probe was unanswered would stay skeletons after it
      // answers — a recycled row is not re-rendered just because `renderItem`
      // changed identity.
      extraData={extraData}
      viewabilityConfig={VIEWABILITY_CONFIG}
      onViewableItemsChanged={handleViewableItemsChanged}
      accessibilityLabel={t('mobile.more.boardLook.presets.carouselAccessibility')}
      contentStyle={contentStyle}
    />
  );
}

function keyExtractor(option: BoardLookOption) {
  return option.id;
}
