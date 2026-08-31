import { useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import { BOARD_LOOK_CARD_WIDTH, BoardLookPreviewCard } from './BoardLookPreviewCard';
import { useBoardRenderSettings } from '../../lib/board-render-settings';
import {
  buildBoardLookPreviewSettings,
  type BoardLookOption,
  type BoardLookOptionId,
} from '../../lib/board-render/board-look-options';
import type { BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import { spacing } from '../../theme/tokens';

const CARD_GAP = spacing[3];
// Snap each card to the leading edge: card width + the gap between cards.
const SNAP_INTERVAL = BOARD_LOOK_CARD_WIDTH + CARD_GAP;

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
    // No `estimatedItemSize` — FlashList v2 removed it in favour of automatic
    // sizing. Cards are fixed-width (BOARD_LOOK_CARD_WIDTH) so layout is stable.
    <FlashList
      data={options as BoardLookOption[]}
      horizontal
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      // Both values `renderItem` closes over that FlashList cannot see for
      // itself. Without the capability latch here, cards that mounted as
      // skeletons while the probe was unanswered would stay skeletons after it
      // answers — a recycled row is not re-rendered just because `renderItem`
      // changed identity.
      extraData={extraData}
      showsHorizontalScrollIndicator={false}
      snapToInterval={SNAP_INTERVAL}
      snapToAlignment="start"
      decelerationRate="fast"
      disableIntervalMomentum
      ItemSeparatorComponent={Separator}
      viewabilityConfig={VIEWABILITY_CONFIG}
      onViewableItemsChanged={handleViewableItemsChanged}
      accessibilityLabel={t('mobile.more.boardLook.presets.carouselAccessibility')}
      contentContainerStyle={[styles.content, contentStyle]}
    />
  );
}

function keyExtractor(option: BoardLookOption) {
  return option.id;
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
  },
  separator: {
    width: CARD_GAP,
  },
});
