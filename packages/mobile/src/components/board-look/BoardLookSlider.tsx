import { useCallback, useEffect, useMemo } from 'react';
import { PixelRatio, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { BoardImageNative } from '../BoardImageNative';
import { LookOptionSlider } from '../LookOptionSlider';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { BoardPreviewSheet } from './BoardPreviewSheet';
import { useEnlargedPreview } from './use-enlarged-preview';
import { useTheme } from '../../providers/theme-provider';
import { useReduceTransparency } from '../../hooks/use-reduce-transparency';
import { useBoardRenderSettings } from '../../lib/board-render-settings';
import { ensureBoardseshSupportProbed } from '../../hooks/use-native-climb-render';
import {
  buildBoardLookPreviewSettings,
  type BoardLookOption,
  type BoardLookOptionId,
} from '../../lib/board-render/board-look-options';
import type { BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import { quantizeRenderWidth } from './board-look-card-metrics';
import { borderRadius, spacing } from '../../theme/tokens';

type BoardLookSliderProps = {
  options: readonly BoardLookOption[];
  selectedId: BoardLookOptionId;
  onSelect: (id: BoardLookOptionId) => void;
  preview: BoardPreviewSource;
  boardseshRendererAvailable: boolean | null;
  onCardSeen?: (id: BoardLookOptionId) => void;
  disabled?: boolean;
  testID?: string;
  heroThumb?: { width: number; height: number } | null;
  showDescription?: boolean;
};

/** One real board preview, changed by a stepped horizontal slider. */
export function BoardLookSlider({
  options,
  selectedId,
  onSelect,
  preview,
  boardseshRendererAvailable,
  onCardSeen,
  disabled,
  testID,
  heroThumb,
  showDescription = true,
}: BoardLookSliderProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const { settings } = useBoardRenderSettings();
  const reduceTransparency = useReduceTransparency();
  const { visibleId, contentId, open, close, handleFullyDismissed } = useEnlargedPreview<BoardLookOptionId>();
  useEffect(() => {
    ensureBoardseshSupportProbed();
  }, []);
  const availableOptions = options;
  const selectedOption = availableOptions.find((option) => option.id === selectedId) ?? availableOptions[0];
  const previewSettings = useMemo(
    () => buildBoardLookPreviewSettings(availableOptions, settings),
    [availableOptions, settings],
  );
  const sliderOptions = useMemo(
    () => availableOptions.map((option) => ({ id: option.id, label: t(option.labelI18nKey) })),
    [availableOptions, t],
  );
  const selectOption = useCallback(
    (id: string) => {
      const option = availableOptions.find((candidate) => candidate.id === id);
      if (option && !disabled) onSelect(option.id);
    },
    [availableOptions, disabled, onSelect],
  );
  const skeleton = !!selectedOption?.requiresBoardseshRenderer && boardseshRendererAvailable !== true;
  useEffect(() => {
    if (selectedOption && !skeleton) onCardSeen?.(selectedOption.id);
  }, [selectedOption, skeleton, onCardSeen]);
  if (!selectedOption) return null;
  const aspect = preview.boardWidth / preview.boardHeight;
  const width = heroThumb?.width ?? Math.min(320, windowWidth - spacing[5] * 2);
  const height = heroThumb?.height ?? Math.min(300, width / aspect);
  const frameWidth = Math.min(width, height * aspect);
  const renderWidth = quantizeRenderWidth(frameWidth, PixelRatio.get(), preview.boardWidth);
  const enlargedOption = contentId ? availableOptions.find((option) => option.id === contentId) : undefined;

  return (
    <View style={styles.root}>
      <View style={[styles.frame, { width: frameWidth, height, backgroundColor: systemColors.tertiaryBackground }]}>
        {skeleton ? (
          <View
            testID="board-look-skeleton"
            style={[StyleSheet.absoluteFill, { backgroundColor: systemColors.fill }]}
          />
        ) : (
          <BoardImageNative
            {...preview}
            accessible
            renderWidth={renderWidth}
            backgroundVariant="full"
            renderSettingsOverride={previewSettings.get(selectedOption.id)}
            recyclingKey={selectedOption.id}
            style={styles.fill}
          />
        )}
        {selectedOption.placeholderOverlay && !skeleton ? (
          <View
            pointerEvents="none"
            testID="board-look-placeholder"
            style={[
              StyleSheet.absoluteFill,
              styles.placeholder,
              { backgroundColor: systemColors.secondaryBackground, opacity: reduceTransparency ? 1 : 0.82 },
            ]}
          >
            <Text variant="largeTitle">?</Text>
          </View>
        ) : null}
        {!skeleton ? (
          <PressableSurface
            testID="board-look-expand-badge"
            accessibilityRole="button"
            accessibilityLabel={t('mobile.settings.boardLook.presets.showFullSize', {
              look: t(selectedOption.labelI18nKey),
            })}
            onPress={() => open(selectedOption.id)}
            style={[styles.expand, { backgroundColor: systemColors.background }]}
          >
            <Icon name="expand" size={17} color={systemColors.label} />
          </PressableSurface>
        ) : null}
      </View>
      <LookOptionSlider
        options={sliderOptions}
        value={selectedOption.id}
        onChange={selectOption}
        accessibilityLabel={t('mobile.settings.boardLook.title')}
        disabled={disabled}
        testID={testID}
      />
      {showDescription ? (
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.description}>
          {t(selectedOption.descriptionI18nKey)}
        </Text>
      ) : null}
      <BoardPreviewSheet
        visible={visibleId != null}
        title={enlargedOption ? t(enlargedOption.labelI18nKey) : null}
        subtitle={enlargedOption ? t(enlargedOption.descriptionI18nKey) : undefined}
        preview={preview}
        renderSettingsOverride={enlargedOption ? previewSettings.get(enlargedOption.id) : undefined}
        renderWidth={renderWidth}
        backgroundVariant="full"
        recyclingKey={contentId ?? undefined}
        onClose={close}
        onFullyDismissed={handleFullyDismissed}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', alignSelf: 'stretch', gap: spacing[2] },
  frame: { borderRadius: borderRadius.lg, overflow: 'hidden' },
  fill: { width: '100%', height: '100%' },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  expand: {
    position: 'absolute',
    bottom: spacing[2],
    right: spacing[2],
    width: 44,
    height: 44,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  description: { paddingHorizontal: spacing[5], textAlign: 'center' },
});
