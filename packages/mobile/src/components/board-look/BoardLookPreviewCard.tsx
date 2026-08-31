import React, { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { BoardImageNative } from '../BoardImageNative';
import { useTheme } from '../../providers/theme-provider';
import { BOARD_PREVIEW_RENDER_WIDTH, type BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import type { BoardLookOption, BoardLookOptionId } from '../../lib/board-render/board-look-options';
import type { BoardRenderSettings } from '../../lib/board-render-settings';
import { borderRadius, spacing } from '../../theme/tokens';

export const BOARD_LOOK_CARD_WIDTH = 168;

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
  const { systemColors } = useTheme();

  const handlePress = useCallback(() => {
    onPress(option.id);
  }, [onPress, option.id]);

  const label = t(option.labelI18nKey);

  return (
    <Pressable
      // A non-selectable card is a report, not a control: the settings screen's
      // Custom card says "your settings match no preset", and applying it would
      // overwrite the hand-tuning it is reporting. Announced as an image so a
      // screen reader doesn't offer an activation that does nothing.
      accessibilityRole={option.selectable ? 'button' : 'image'}
      accessibilityState={option.selectable ? { selected } : { selected, disabled: true }}
      accessibilityLabel={`${label}. ${t(option.descriptionI18nKey)}`}
      onPress={option.selectable ? handlePress : undefined}
      disabled={!option.selectable}
      style={[
        styles.card,
        {
          backgroundColor: systemColors.secondaryBackground,
          // Colour only — the width is constant in `styles.card`. Growing the
          // border on selection changes the card's content box, which relayouts
          // the board image underneath it and reads as a flicker on every tap.
          borderColor: selected ? systemColors.accent : systemColors.separator,
        },
      ]}
    >
      <View style={styles.preview}>
        {showSkeleton ? (
          <View style={[styles.skeleton, { backgroundColor: systemColors.fill }]} />
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
          />
        )}
        {option.placeholderOverlay && !showSkeleton ? (
          // The Custom card in onboarding: a real Boardsesh render, deliberately
          // obscured. There is nothing of the climber's own to show yet — the
          // point of the card is that they are about to go and build it.
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, styles.placeholder, { backgroundColor: systemColors.secondaryBackground }]}
          >
            <Text variant="largeTitle" color={systemColors.label}>
              ?
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.caption}>
        <Text variant="subheadline" numberOfLines={1}>
          {label}
        </Text>
        <Text variant="caption2" color={systemColors.secondaryLabel} numberOfLines={2}>
          {t(option.descriptionI18nKey)}
        </Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    width: BOARD_LOOK_CARD_WIDTH,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    // Constant, so selecting a card never changes its layout — only the colour.
    borderWidth: 2,
  },
  preview: {
    width: '100%',
  },
  skeleton: {
    width: '100%',
    // Roughly a board's aspect; the real image sets its own from the geometry.
    aspectRatio: 1,
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.82,
  },
  caption: {
    padding: spacing[2],
    gap: spacing[1],
  },
});
