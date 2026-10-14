// The add-a-wall background phase's preview: the draft drawn on one background.
// The choice itself is a segmented row under it (`spray-look-model.ts`); the
// edit-wall picker keeps its tiles.
import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import type { ReferenceSize } from '@boardsesh/spray-wall-geometry';
import { ActivityIndicator } from '../ActivityIndicator';
import { useAppColorScheme, useTheme } from '../../providers/theme-provider';
import type { SprayWallBackground } from '../../lib/spray/spray-wall-background';
import { lookPreviewMask, lookPreviewTileSize, type SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';
import { useSprayLookPreviewPhoto } from '../../lib/spray/use-spray-look-preview-photo';
import { SprayWallBackgroundVisual } from './SprayWallBackgroundPicker';

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

type SprayWallBackgroundPreviewProps = {
  /** The background to draw: the creator's pick, or the photo while the gate refuses it. */
  value: SprayWallBackground;
  previewSource: SprayLookPreviewSource | null;
  unavailable?: boolean;
};

/**
 * The background phase's one preview, fitted inside whatever slot it is given
 * (a fixed-height form row): the photo in its own frame, a generated look in
 * the wall's canonical one.
 */
export function SprayWallBackgroundPreview({
  value,
  previewSource,
  unavailable = false,
}: SprayWallBackgroundPreviewProps) {
  const [slot, setSlot] = useState({ width: 0, height: 0 });
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSlot((current) => (current.width === width && current.height === height ? current : { width, height }));
  }, []);
  const tile = useMemo(
    () =>
      lookPreviewTileSize(
        (value === 'photo' ? previewSource?.photo : previewSource?.frame) ?? FALLBACK_FRAME,
        slot.width,
        slot.height,
      ),
    [value, previewSource?.photo, previewSource?.frame, slot.width, slot.height],
  );

  return (
    <View style={styles.slot} onLayout={handleLayout} testID="spray-background-preview-slot">
      {tile ? (
        <View style={{ width: tile.width, height: tile.height }}>
          <SprayWallDraftBackgroundPreview
            value={value}
            size={tile}
            previewSource={previewSource}
            unavailable={unavailable}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loading: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
});
