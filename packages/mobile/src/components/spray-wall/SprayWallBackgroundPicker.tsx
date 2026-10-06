// "Photo / Wall only / Holds only" — what a spray wall is drawn on.
//
// Wall only is the photo flattened into the wall's frame and cropped to it;
// Holds only is the same pixels with everything but the holds cut away, drawn
// on the board's field colour. Both are made by the backend per published
// version (`sprayWallArt`), so this picker reads that one answer for whether
// they can be offered, whether they are ready, and what they look like.
//
// Rendered by the add-a-wall look step (a draft: nothing is generated until the
// publish) and by the wall's edit screen (the live wall).

import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import type { SprayWallArt } from '@boardsesh/graphql/generated/graphql';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { SegmentedControl } from '../SegmentedControl';
import { useAppColorScheme, useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import type { SprayWallBackground } from '../../lib/spray/spray-wall-background';
import { backgroundPickerNote, type SprayBackgroundGate } from './spray-background-gate';

const GENERATED_BACKGROUNDS: ReadonlySet<SprayWallBackground> = new Set(['wall-crop', 'hold-cutouts']);
const ALL_BACKGROUNDS: ReadonlySet<SprayWallBackground> = new Set(['photo', 'wall-crop', 'hold-cutouts']);

export type SprayWallBackgroundPickerProps = {
  gate: SprayBackgroundGate;
  art: SprayWallArt | null | undefined;
  value: SprayWallBackground;
  onChange: (background: SprayWallBackground) => void;
  disabled?: boolean;
  /** The wall's existing retake flow, where there is one. Shown on a locked gate. */
  onRetakePhoto?: () => void;
  /** A draft: the looks are made when it is published, so say that instead of "Generating". */
  isDraft?: boolean;
};

export const SprayWallBackgroundPicker = memo(function SprayWallBackgroundPicker({
  gate,
  art,
  value,
  onChange,
  disabled = false,
  onRetakePhoto,
  isDraft = false,
}: SprayWallBackgroundPickerProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const colorScheme = useAppColorScheme();

  const options = useMemo(
    () => [
      { key: 'photo' as const, label: t('sprayBackground.photo') },
      { key: 'wall-crop' as const, label: t('sprayBackground.wallCrop') },
      { key: 'hold-cutouts' as const, label: t('sprayBackground.holdCutouts') },
    ],
    [t],
  );
  const locked = gate.kind !== 'open';
  const disabledKeys = useMemo(
    () => (disabled ? ALL_BACKGROUNDS : locked ? GENERATED_BACKGROUNDS : undefined),
    [disabled, locked],
  );
  const handleSelect = useCallback(
    (key: SprayWallBackground) => {
      if (disabled) return;
      if (locked && key !== 'photo') return;
      onChange(key);
    },
    [disabled, locked, onChange],
  );

  const note = backgroundPickerNote(gate, value, isDraft);
  // A soft photo still gets the volumes line when Holds only is picked: two
  // short facts, and the volumes one is the one that changes what is on the wall.
  const showVolumes = note === 'soft' && value === 'hold-cutouts';

  const preview =
    gate.kind === 'open' && gate.status === 'ready' && !isDraft && value !== 'photo'
      ? value === 'wall-crop'
        ? art?.crop
        : art?.cutout
      : null;
  const previewUri = preview?.thumbUrl ?? preview?.url ?? null;
  const previewSource = useMemo(() => (previewUri ? { uri: previewUri } : null), [previewUri]);
  const previewAspect = art?.width && art?.height ? art.width / art.height : null;
  const previewStyle = useMemo(
    () => [
      styles.preview,
      {
        aspectRatio: previewAspect ?? 1,
        // Holds only is transparent by design: drawn on the field colour, as on the wall.
        backgroundColor: value === 'hold-cutouts' ? BOARD_FIELD_COLORS[colorScheme] : systemColors.secondaryBackground,
      },
    ],
    [previewAspect, value, colorScheme, systemColors.secondaryBackground],
  );
  const selectedLabel = options.find((option) => option.key === value)?.label ?? '';

  if (gate.kind === 'loading' || gate.kind === 'unsupported') return null;

  return (
    <View style={styles.root}>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.label}>
        {t('sprayBackground.label')}
      </Text>
      <SegmentedControl<SprayWallBackground>
        options={options}
        selectedKey={value}
        onSelect={handleSelect}
        disabledKeys={disabledKeys}
        accessibilityLabel={t('sprayBackground.label')}
      />
      {note ? (
        <View style={styles.noteRow}>
          {note === 'generating' ? <ActivityIndicator size="small" /> : null}
          <Text
            variant="footnote"
            color={systemColors.secondaryLabel}
            style={styles.note}
            accessibilityLiveRegion="polite"
            testID={`spray-background-note-${note}`}
          >
            {t(`sprayBackground.note.${note}`)}
          </Text>
        </View>
      ) : null}
      {showVolumes ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} testID="spray-background-note-volumes">
          {t('sprayBackground.note.volumes')}
        </Text>
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
      {previewSource ? (
        <Image
          source={previewSource}
          style={previewStyle}
          contentFit="contain"
          accessibilityLabel={t('sprayBackground.previewLabel', { look: selectedLabel })}
          testID="spray-background-preview"
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
  preview: {
    width: '100%',
    maxHeight: 220,
    borderRadius: borderRadius.md,
  },
});
