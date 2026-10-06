// "Crop or rotate": the photo step's detour, shared by "Add a spray wall" and
// "Reset a wall".
//
// A crop box over the photo and a Rotate button above it. Nothing here touches
// the uploaded file: the step works on an edit (`photo-edit.ts`) over the BASE —
// the first compressed, uncropped copy — and hands it to the screen on Done,
// which renders it from the picker's original in one pass. Re-opening the step
// starts from the base again, with the last edit as the starting point, so a
// crop can be loosened as well as tightened.
//
// Rotation is a rendered preview, not a view transform. A rotated view hands pan
// translations back in its own axes, so every drag on the box would need turning
// back, per frame, on the UI thread. Each quarter turn instead renders the base
// turned (`renderRotatedPreview`, cached per turn for the life of the step) and
// the crop box only ever works in the space the climber sees.
//
// The page layout is the corner step's (`useFittedPhotoStage`): copy at the top,
// the photo fitted into everything left over, and a footer whose height never
// changes, so the photo is not re-fitted under a finger.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { useTheme } from '../../providers/theme-provider';
import { useTransparentHeaderInset } from '../../hooks/use-transparent-header-inset';
import { spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { reportError } from '../../lib/error-reporting';
import { discardLocalPhoto } from '../../lib/spray/discard-local-photo';
import { WALL_PHOTO_MAX_DIMENSION, renderRotatedPreview } from '../../lib/spray/wall-photo';
import {
  IDENTITY_EDIT,
  enforceMinimumCrop,
  isIdentityEdit,
  isPhotoSmall,
  minimumCropFractions,
  predictedEditOutput,
  rotateEditClockwise,
  rotatedSize,
  type EditableWallPhoto,
  type NormalizedRect,
  type QuarterTurns,
  type WallPhotoEdit,
} from '../../lib/spray/photo-edit';
import { SprayCornerFooter } from './SprayCornerFooter';
import { SprayCropMarker } from './SprayCropMarker';
import { MIN_STAGE_HEIGHT, useFittedPhotoStage } from './use-fitted-photo-stage';

export type SprayPhotoAdjustStepProps = {
  title: string;
  /** What to crop to. The reset flow adds that all four corners must stay inside. */
  body: string;
  photo: EditableWallPhoto;
  /** The screen is rendering the edit Done handed it. */
  processing: boolean;
  /** True after the last render failed; the step says so and keeps the edit. */
  failed: boolean;
  /** Done: the edit to render. The identity edit means "the photo as picked". */
  onDone: (edit: WallPhotoEdit) => void;
  /** Cancel: leave without changing the photo. */
  onCancel: () => void;
};

export function SprayPhotoAdjustStep({
  title,
  body,
  photo,
  processing,
  failed,
  onDone,
  onCancel,
}: SprayPhotoAdjustStepProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const headerInset = useTransparentHeaderInset();
  const fittedStage = useFittedPhotoStage();

  const base = photo.base;
  const [edit, setEdit] = useState<WallPhotoEdit>(() => photo.edit ?? IDENTITY_EDIT);
  const turns = edit.quarterTurns;

  // ---- Rotated previews, one file per quarter turn, rendered on first need.
  const previewsRef = useRef<Map<QuarterTurns, string>>(new Map([[0, base.uri]]));
  const [previewUri, setPreviewUri] = useState<string | null>(base.uri);
  const [previewFailed, setPreviewFailed] = useState(false);
  const unmountedRef = useRef(false);
  useEffect(() => {
    const cached = previewsRef.current.get(turns);
    if (cached) {
      setPreviewUri(cached);
      setPreviewFailed(false);
      return;
    }
    // A turn tapped again before this one rendered must not be overwritten by
    // it landing late.
    let current = true;
    setPreviewUri(null);
    setPreviewFailed(false);
    renderRotatedPreview(base, turns).then(
      (uri) => {
        // Landed after the step closed: nothing will ever draw it.
        if (unmountedRef.current) {
          discardLocalPhoto(uri);
          return;
        }
        previewsRef.current.set(turns, uri);
        if (current) setPreviewUri(uri);
      },
      (error: unknown) => {
        reportError(error);
        if (current) setPreviewFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [base, turns]);

  // The previews are this step's own files. The base is not, and stays.
  useEffect(() => {
    const previews = previewsRef.current;
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      for (const uri of previews.values()) {
        if (uri !== base.uri) discardLocalPhoto(uri);
      }
    };
  }, [base.uri]);

  const minSize = useMemo(() => minimumCropFractions(base, turns), [base, turns]);
  const displayed = useMemo(
    () => (previewUri ? { uri: previewUri, ...rotatedSize(base, turns) } : null),
    [previewUri, base, turns],
  );

  const rotate = useCallback(() => {
    setEdit((previous) => {
      const turned = rotateEditClockwise(previous);
      // A crop that was wide enough across may be too short now that its width
      // has become its height.
      return {
        ...turned,
        crop: enforceMinimumCrop(turned.crop, minimumCropFractions(base, turned.quarterTurns)),
      };
    });
  }, [base]);
  const resetEdit = useCallback(() => setEdit(IDENTITY_EDIT), []);
  const onCropChange = useCallback((crop: NormalizedRect) => {
    setEdit((previous) => ({ ...previous, crop }));
  }, []);
  const done = useCallback(() => onDone(edit), [onDone, edit]);

  // A soft warning, never a gate: a short wall shot close can be fine at 1000 px.
  const small = isPhotoSmall(predictedEditOutput(edit, base, photo.original.longSide, WALL_PHOTO_MAX_DIMENSION));

  // One slot for the three things that can sit under the photo, as tall as the
  // tallest at this width and text size — so the photo is never re-fitted
  // because a crop crossed the small-photo line.
  const hint = failed || previewFailed ? 'failed' : small ? 'small' : 'hint';
  const [slotHeights, setSlotHeights] = useState({ hint: 0, small: 0, failed: 0 });
  const probe = useCallback(
    (key: 'hint' | 'small' | 'failed') => (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      setSlotHeights((previous) => (previous[key] === height ? previous : { ...previous, [key]: height }));
    },
    [],
  );
  const hintCopy = {
    hint: t('sprayWizard.adjust.hint'),
    small: t('sprayWizard.adjust.small'),
    failed: t('sprayWizard.adjust.failed'),
  };

  const busy = processing || displayed == null;

  return (
    <View style={styles.flex}>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={[styles.content, { paddingTop: headerInset + spacing[4] }]}
        {...fittedStage.scrollProps}
        bounces={false}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="title3">{title}</Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {body}
        </Text>
        <View style={styles.rotateRow}>
          <Button
            title={t('sprayWizard.adjust.rotate')}
            accessibilityLabel={t('sprayWizard.adjust.rotateLabel')}
            icon="refresh"
            variant="tonal"
            size="small"
            onPress={rotate}
            disabled={busy}
          />
        </View>
        <View style={styles.stage} onLayout={fittedStage.onStageLayout}>
          {displayed ? (
            <SprayCropMarker
              photo={displayed}
              maxWidth={fittedStage.maxPhotoWidth}
              maxHeight={fittedStage.maxPhotoHeight}
              value={edit.crop}
              onChange={onCropChange}
              minSize={minSize}
              onDragActiveChange={fittedStage.onDragActiveChange}
            />
          ) : previewFailed ? null : (
            <ActivityIndicator />
          )}
        </View>
        <View style={{ minHeight: Math.max(slotHeights.hint, slotHeights.small, slotHeights.failed) }}>
          <Text
            variant="footnote"
            color={
              hint === 'failed'
                ? iosSystemColors.systemRed
                : hint === 'small'
                  ? iosSystemColors.systemOrange
                  : systemColors.secondaryLabel
            }
            style={styles.hint}
            accessibilityLiveRegion={hint === 'hint' ? 'none' : 'polite'}
          >
            {hintCopy[hint]}
          </Text>
          {(['hint', 'small', 'failed'] as const).map((key) => (
            <Text
              key={key}
              variant="footnote"
              style={[styles.hint, styles.hintProbe]}
              onLayout={probe(key)}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {hintCopy[key]}
            </Text>
          ))}
        </View>
      </ScrollView>
      <SprayCornerFooter
        primaryTitle={t('sprayWizard.adjust.done')}
        onPrimary={done}
        primaryDisabled={busy}
        primaryLoading={processing}
        canClear={!isIdentityEdit(edit) && !processing}
        onClear={resetEdit}
        clearTitle={t('sprayWizard.adjust.reset')}
        onBack={onCancel}
        backTitle={t('sprayWizard.adjust.cancel')}
        backDisabled={processing}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
    gap: spacing[2],
  },
  rotateRow: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  stage: {
    flex: 1,
    minHeight: MIN_STAGE_HEIGHT,
    marginHorizontal: -spacing[4],
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: {
    textAlign: 'center',
    paddingHorizontal: spacing[4],
  },
  hintProbe: {
    position: 'absolute',
    left: 0,
    right: 0,
    opacity: 0,
    pointerEvents: 'none',
  },
});
