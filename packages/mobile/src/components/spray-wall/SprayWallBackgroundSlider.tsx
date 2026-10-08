// A draft background choice: one preview and a stepped horizontal slider.
// The edit-wall picker keeps its tiles; this surface belongs to the wizard.
import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import type { ReferenceSize } from '@boardsesh/spray-wall-geometry';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { LookOptionSlider } from '../LookOptionSlider';
import { useAppColorScheme, useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import type { SprayWallBackground } from '../../lib/spray/spray-wall-background';
import { lookPreviewMask, lookPreviewTileSize, type SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';
import { useSprayLookPreviewPhoto } from '../../lib/spray/use-spray-look-preview-photo';
import { SprayWallBackgroundVisual } from './SprayWallBackgroundPicker';
import { backgroundPickerNote, canPickBackground, type SprayBackgroundGate } from './spray-background-gate';

const BACKGROUNDS: readonly SprayWallBackground[] = ['photo', 'wall-crop', 'hold-cutouts'];
const FALLBACK_FRAME = { width: 4, height: 3 };

/** A single draft background, in its own photo or canonical coordinate frame. */
export const SprayWallDraftBackgroundPreview = memo(function SprayWallDraftBackgroundPreview({
  value,
  size,
  previewSource,
  unavailable = false,
}: {
  value: SprayWallBackground;
  size: ReferenceSize;
  previewSource: SprayLookPreviewSource | null;
  unavailable?: boolean;
}) {
  const { systemColors } = useTheme();
  const colorScheme = useAppColorScheme();
  const photoUri = useSprayLookPreviewPhoto(previewSource);
  const mask = useMemo(
    () => (previewSource ? lookPreviewMask(previewSource.holds, size.width / previewSource.frame.width) : null),
    [previewSource, size.width],
  );
  return (
    <View pointerEvents="none" accessible={false} style={StyleSheet.absoluteFill}>
      <SprayWallBackgroundVisual
        look={value}
        tile={size}
        source={previewSource}
        photoUri={photoUri}
        storedUri={null}
        mask={mask}
        fieldColor={BOARD_FIELD_COLORS[colorScheme]}
        placeholderColor={systemColors.secondaryBackground}
        locked={false}
      />
      {!photoUri && !unavailable ? <ActivityIndicator style={styles.loading} /> : null}
    </View>
  );
});

type SprayWallBackgroundSliderProps = {
  gate: SprayBackgroundGate;
  value: SprayWallBackground;
  onChange: (background: SprayWallBackground) => void;
  disabled?: boolean;
  previewSource: SprayLookPreviewSource | null;
  unavailable?: boolean;
};

export function SprayWallBackgroundSlider({
  gate,
  value,
  onChange,
  disabled = false,
  previewSource,
  unavailable = false,
}: SprayWallBackgroundSliderProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const [slot, setSlot] = useState({ width: 0, height: 0 });
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSlot((current) => (current.width === width && current.height === height ? current : { width, height }));
  }, []);
  const options = useMemo(
    () =>
      BACKGROUNDS.filter((background) => canPickBackground(gate, background)).map((background) => ({
        id: background,
        label:
          background === 'photo'
            ? t('sprayBackground.photo')
            : background === 'wall-crop'
              ? t('sprayBackground.wallCrop')
              : t('sprayBackground.holdCutouts'),
      })),
    [gate, t],
  );
  const selectBackground = useCallback(
    (id: string) => {
      if (disabled || gate.kind === 'loading') return;
      const background = BACKGROUNDS.find((choice) => choice === id);
      if (background && canPickBackground(gate, background)) onChange(background);
    },
    [disabled, gate, onChange],
  );
  const selected = canPickBackground(gate, value) ? value : 'photo';
  const tile = useMemo(
    () =>
      lookPreviewTileSize(
        (selected === 'photo' ? previewSource?.photo : previewSource?.frame) ?? FALLBACK_FRAME,
        slot.width,
        slot.height,
      ),
    [selected, previewSource?.photo, previewSource?.frame, slot.width, slot.height],
  );
  const note = backgroundPickerNote(gate, selected, true);
  const noteText = note ? t(`sprayBackground.note.${note}`) : null;

  return (
    <View style={styles.root}>
      <View style={styles.previewSlot} onLayout={handleLayout} testID="spray-background-preview-slot">
        {tile ? (
          <View style={{ width: tile.width, height: tile.height }}>
            <SprayWallDraftBackgroundPreview
              value={selected}
              size={tile}
              previewSource={previewSource}
              unavailable={unavailable}
            />
          </View>
        ) : null}
      </View>
      {unavailable ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('sprayWizard.look.unavailable')}
        </Text>
      ) : null}
      <LookOptionSlider
        options={options}
        value={selected}
        onChange={selectBackground}
        accessibilityLabel={t('sprayBackground.label')}
        disabled={disabled || gate.kind === 'loading'}
        testID="spray-background-slider"
      />
      {gate.kind === 'loading' ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
          {t('sprayWizard.look.loading')}
        </Text>
      ) : gate.kind === 'unsupported' ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('sprayWizard.background.unsupported')}
        </Text>
      ) : noteText ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} testID={`spray-background-note-${note}`}>
          {noteText}
        </Text>
      ) : null}
      {gate.kind === 'open' && selected === 'hold-cutouts' ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('sprayBackground.note.volumes')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: spacing[4], paddingBottom: spacing[4], gap: spacing[2] },
  previewSlot: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 240 },
  loading: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
});
