// "Photo / Wall only / Holds only" — what a spray wall is drawn on.
//
// Wall only is the photo flattened into the wall's frame and cropped to it;
// Holds only is the same pixels with everything but the holds cut away, drawn
// on the board's field colour. The backend makes both per published version
// (`sprayWallArt`), and this picker reads that one answer for whether they can
// be offered.
//
// Each look is a tile showing it. The tiles are drawn on the phone from the
// version's photo, pins and holds (`FlattenedSprayPhoto`), so a draft in the
// add-a-wall flow shows every look before anything is generated, and a live
// wall shows its stored art instead once that is ready. The live drawing is
// only for choosing: what climbers see is the backend's art.
//
// Rendered by the add-a-wall look step and by the wall's edit screen.

import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ColorValue, type LayoutChangeEvent } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import Svg, { Path } from 'react-native-svg';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import type { ReferenceSize } from '@boardsesh/spray-wall-geometry';
import type { SprayWallArt } from '@boardsesh/graphql/generated/graphql';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { useAppColorScheme, useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import type { SprayWallBackground } from '../../lib/spray/spray-wall-background';
import {
  lookPreviewMask,
  lookPreviewTileSize,
  type LookPreviewMask,
  type SprayLookPreviewSource,
} from '../../lib/spray/spray-look-preview';
import { FlattenedSprayPhoto } from './FlattenedSprayPhoto';
import { backgroundPickerNote, type SprayBackgroundGate } from './spray-background-gate';

const LOOKS: readonly SprayWallBackground[] = ['photo', 'wall-crop', 'hold-cutouts'];

/** The tallest a tile grows, so a tall wall does not push the Continue button off screen. */
const TILE_MAX_HEIGHT = 160;
/** Room the selected ring takes on each side of a tile. */
const TILE_RING = 2;
/** The frame shape a tile takes before the wall's own is known. */
const FALLBACK_FRAME: ReferenceSize = { width: 4, height: 3 };

export type SprayWallBackgroundPickerProps = {
  gate: SprayBackgroundGate;
  art: SprayWallArt | null | undefined;
  value: SprayWallBackground;
  onChange: (background: SprayWallBackground) => void;
  disabled?: boolean;
  /** The wall's existing retake flow, where there is one. Shown on a locked gate. */
  onRetakePhoto?: () => void;
  /** A draft: nothing is generated until it is published, so every tile is drawn on the phone. */
  isDraft?: boolean;
  /** The version's photo, pins and holds, for the tiles drawn on the phone. Null while it loads. */
  previewSource?: SprayLookPreviewSource | null;
};

type TileVisualProps = {
  look: SprayWallBackground;
  tile: ReferenceSize;
  source: SprayLookPreviewSource | null;
  /** The backend's art for this look, when it is ready and is what the wall will show. */
  storedUri: string | null;
  mask: LookPreviewMask | null;
  fieldColor: ColorValue;
  placeholderColor: ColorValue;
  locked: boolean;
};

const TileVisual = memo(function TileVisual({
  look,
  tile,
  source,
  storedUri,
  mask,
  fieldColor,
  placeholderColor,
  locked,
}: TileVisualProps) {
  const sizeStyle = useMemo(() => ({ width: tile.width, height: tile.height }), [tile]);
  const photoSource = useMemo(() => (source ? { uri: source.photoUrl } : null), [source]);
  const storedSource = useMemo(() => (storedUri ? { uri: storedUri } : null), [storedUri]);
  const backgroundStyle = useMemo(
    () => ({ backgroundColor: look === 'hold-cutouts' && !locked ? fieldColor : placeholderColor }),
    [look, locked, fieldColor, placeholderColor],
  );

  // Every image here is memory-cached only: this is a private wall's photo and
  // art, and nothing clears expo-image's disk cache on sign-out or when a wall
  // is withdrawn.
  let content: ReactNode = null;
  if (look === 'photo') {
    content = photoSource ? (
      <Image source={photoSource} style={sizeStyle} contentFit="contain" cachePolicy="memory" accessible={false} />
    ) : null;
  } else if (locked) {
    content = null;
  } else if (storedSource) {
    content = (
      <Image
        source={storedSource}
        style={sizeStyle}
        contentFit="fill"
        cachePolicy="memory"
        accessible={false}
        testID={`spray-background-stored-${look}`}
      />
    );
  } else if (source && look === 'wall-crop') {
    content = <FlattenedSprayPhoto source={source} tile={tile} />;
  } else if (source && mask) {
    content = (
      <MaskedView
        style={sizeStyle}
        maskElement={
          <Svg width={tile.width} height={tile.height}>
            {/* The job feathers its mask with a Gaussian blur; a soft, wider
                stroke under the hard edge is the cheap stand-in. */}
            <Path
              d={mask.path}
              fill="#000"
              stroke="#000"
              strokeOpacity={0.4}
              strokeWidth={2 * (mask.grow + mask.feather)}
              strokeLinejoin="round"
            />
            <Path d={mask.path} fill="#000" stroke="#000" strokeWidth={2 * mask.grow} strokeLinejoin="round" />
          </Svg>
        }
      >
        <FlattenedSprayPhoto source={source} tile={tile} />
      </MaskedView>
    );
  }

  return (
    <View style={[styles.tileVisual, sizeStyle, backgroundStyle]} testID={`spray-background-tile-visual-${look}`}>
      {content}
    </View>
  );
});

export const SprayWallBackgroundPicker = memo(function SprayWallBackgroundPicker({
  gate,
  art,
  value,
  onChange,
  disabled = false,
  onRetakePhoto,
  isDraft = false,
  previewSource = null,
}: SprayWallBackgroundPickerProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const colorScheme = useAppColorScheme();

  const labels = useMemo<Record<SprayWallBackground, string>>(
    () => ({
      photo: t('sprayBackground.photo'),
      'wall-crop': t('sprayBackground.wallCrop'),
      'hold-cutouts': t('sprayBackground.holdCutouts'),
    }),
    [t],
  );
  const locked = gate.kind !== 'open';
  const handleSelect = useCallback(
    (key: SprayWallBackground) => {
      if (disabled) return;
      if (locked && key !== 'photo') return;
      onChange(key);
    },
    [disabled, locked, onChange],
  );

  const [rowWidth, setRowWidth] = useState(0);
  const handleRowLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    setRowWidth((current) => (current === width ? current : width));
  }, []);

  const artWidth = art?.width ?? null;
  const artHeight = art?.height ?? null;
  const frame = useMemo<ReferenceSize>(() => {
    if (previewSource) return previewSource.frame;
    if (artWidth && artHeight) return { width: artWidth, height: artHeight };
    return FALLBACK_FRAME;
  }, [previewSource, artWidth, artHeight]);
  const tile = useMemo(() => {
    if (rowWidth <= 0) return null;
    const slot = (rowWidth - 2 * spacing[2]) / LOOKS.length - 2 * TILE_RING;
    return lookPreviewTileSize(frame, slot, TILE_MAX_HEIGHT);
  }, [rowWidth, frame]);
  const mask = useMemo(
    () => (previewSource && tile ? lookPreviewMask(previewSource.holds, tile.width / previewSource.frame.width) : null),
    [previewSource, tile],
  );

  // The stored art, on a live wall whose art is ready: what the wall will
  // actually show. A draft has none, and anything not ready draws on the phone.
  const showStored = gate.kind === 'open' && gate.status === 'ready' && !isDraft;
  const storedCrop = showStored ? (art?.crop?.thumbUrl ?? art?.crop?.url ?? null) : null;
  const storedCutout = showStored ? (art?.cutout?.thumbUrl ?? art?.cutout?.url ?? null) : null;

  const note = backgroundPickerNote(gate, value, isDraft);
  const noteText = note ? t(`sprayBackground.note.${note}`) : null;
  // A Holds-only pick always hears about volumes, unless that is the note already.
  const showVolumes = gate.kind === 'open' && value === 'hold-cutouts' && note !== 'volumes';

  if (gate.kind === 'loading' || gate.kind === 'unsupported') return null;

  const fieldColor = BOARD_FIELD_COLORS[colorScheme];

  return (
    <View style={styles.root}>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.label}>
        {t('sprayBackground.label')}
      </Text>
      {/* Tiles, not a native segmented control: iOS's segmented Picker cannot
          disable one segment, so a refused tap would leave "Wall only"
          highlighted while nothing was chosen. A tile only looks selected
          when it is the value. While a save is running every tile is held
          still, and says so to VoiceOver and TalkBack. */}
      <View
        style={styles.row}
        onLayout={handleRowLayout}
        pointerEvents={disabled ? 'none' : 'auto'}
        accessibilityRole="radiogroup"
        accessibilityLabel={t('sprayBackground.label')}
        accessibilityState={{ disabled }}
        testID="spray-background-control"
      >
        {LOOKS.map((look) => {
          const label = labels[look];
          const lookLocked = locked && look !== 'photo';
          const selected = value === look;
          return (
            <Pressable
              key={look}
              onPress={() => handleSelect(look)}
              disabled={disabled || lookLocked}
              accessibilityRole="radio"
              accessibilityLabel={t('sprayBackground.previewLabel', { look: label })}
              accessibilityHint={lookLocked && noteText ? noteText : undefined}
              accessibilityState={{ selected, disabled: disabled || lookLocked }}
              style={[
                styles.tile,
                { borderColor: selected ? systemColors.accent : 'transparent' },
                lookLocked || disabled ? styles.dimmed : null,
              ]}
              testID={`spray-background-tile-${look}`}
            >
              {tile ? (
                <TileVisual
                  look={look}
                  tile={tile}
                  source={previewSource}
                  storedUri={look === 'wall-crop' ? storedCrop : look === 'hold-cutouts' ? storedCutout : null}
                  mask={mask}
                  fieldColor={fieldColor}
                  placeholderColor={systemColors.secondaryBackground}
                  locked={lookLocked}
                />
              ) : null}
              <Text
                variant="footnote"
                color={selected ? systemColors.label : systemColors.secondaryLabel}
                style={styles.tileLabel}
                numberOfLines={2}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {noteText ? (
        <View style={styles.noteRow}>
          {note === 'generating' ? <ActivityIndicator size="small" /> : null}
          <Text
            variant="footnote"
            color={systemColors.secondaryLabel}
            style={styles.note}
            accessibilityLiveRegion="polite"
            testID={`spray-background-note-${note}`}
          >
            {noteText}
          </Text>
        </View>
      ) : null}
      {showVolumes ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} testID="spray-background-note-volumes">
          {t('sprayBackground.note.volumes')}
        </Text>
      ) : null}
      {locked && value !== 'photo' ? (
        // A stored generated look the photo no longer qualifies for: the photo
        // is still one tap away.
        <Button
          title={t('sprayBackground.usePhoto')}
          variant="text"
          onPress={() => handleSelect('photo')}
          disabled={disabled}
          style={styles.retake}
        />
      ) : null}
      {gate.kind === 'locked' && onRetakePhoto ? (
        <Button
          title={t('sprayBackground.retake')}
          variant="text"
          onPress={onRetakePhoto}
          disabled={disabled}
          style={styles.retake}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    gap: spacing[2],
  },
  label: {
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    gap: spacing[2],
    alignItems: 'flex-start',
  },
  tile: {
    flex: 1,
    alignItems: 'center',
    gap: spacing[1],
    borderWidth: TILE_RING,
    borderRadius: borderRadius.md + TILE_RING,
    paddingBottom: spacing[1],
  },
  tileVisual: {
    borderRadius: borderRadius.md,
    overflow: 'hidden',
  },
  dimmed: {
    opacity: 0.5,
  },
  tileLabel: {
    textAlign: 'center',
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  note: {
    flexShrink: 1,
  },
  retake: {
    alignSelf: 'flex-start',
  },
});
