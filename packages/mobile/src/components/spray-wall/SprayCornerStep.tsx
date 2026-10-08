// The "mark the corners" step's body, shared by "Add a spray wall" and "Reset a
// wall" (issue #5958).
//
// The whole photo is on screen, with all four rings, and the step does not
// scroll. It used to be one section of a scrolling page with the photo drawn to
// the page's width: a portrait photo ran past the footer, and reaching the two
// bottom rings meant scrolling in the same place a vertical drag moves a ring.
//
// So the copy takes the height it needs, the photo gets everything left over
// (`stage`, measured), and the marker fits the photo inside that.
//
// The one exception is a screen with so little room left that the photo would
// be too small to aim at: below `MIN_STAGE_HEIGHT` the photo stops shrinking and
// the step scrolls instead. That is not only a large-text case. On a 375x667
// phone the reset flow's longer copy leaves the stage within a line of text of
// the floor at the default size, so it has to be safe: the page is held still
// for as long as a finger is on a ring, and a drag can never become a scroll.
//
// "Start the corners again" sits in a row of its own above the photo, the way
// the crop step puts Rotate and Reset there. It is always drawn and only
// disabled until there are corners to undo, so the photo is never re-fitted at
// the moment a drag ends. Back, Skip and Next are in the header.
//
// Nothing under the photo changes height either. The hint and the "those
// corners cross over" sentence that replaces it share one slot, sized for the
// taller of the two, so a refused quad does not re-fit the photo as the finger
// lifts.

import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Quad, ReferenceSize } from '@boardsesh/spray-wall-geometry';
import { cornerQualityNote } from './corner-quality';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { useTransparentHeaderInset } from '../../hooks/use-transparent-header-inset';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
import { spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { SprayCornerMarker } from './SprayCornerMarker';
import { MIN_STAGE_HEIGHT, useFittedPhotoStage } from './use-fitted-photo-stage';

export type SprayCornerStepProps = {
  /** "Step 3 of 6", already translated, or null where the step is not counted. */
  stepCounter: string | null;
  title: string;
  body: string;
  photo: { uri: string; width: number; height: number };
  /** The quad to open with, in photo pixels, or null to start from the default inset. */
  value: Quad | null;
  /** Fired when a corner is released, with all four in photo pixels, TL/TR/BR/BL. */
  onChange: (quad: Quad) => void;
  /** True once the quad has been refused for crossing itself. */
  invalid: boolean;
  /**
   * The wall's canonical frame, to grade the corners against: the photo's own
   * size for a new wall (version 1 defines the frame), the wall's stored frame
   * for a reset. Left out, no grade is shown.
   */
  qualityFrame?: ReferenceSize | null;
  /** True once there are corners to throw away. */
  canClear: boolean;
  /** "Start the corners again": back to the default rings. */
  onClear: () => void;
};

const QUALITY_NOTES = ['good', 'soft', 'fail', 'small'] as const;

export function SprayCornerStep({
  stepCounter,
  title,
  body,
  photo,
  value,
  onChange,
  invalid,
  qualityFrame,
  canClear,
  onClear,
}: SprayCornerStepProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const headerInset = useTransparentHeaderInset();
  const bottomInset = useWindowBottomInset();

  // The measured stage, the scroll-when-it-must rule and the hold-still-while-
  // dragging lock, shared with the crop step.
  const fittedStage = useFittedPhotoStage();

  // One slot for the hint and for the refusal that replaces it, as tall as the
  // taller of the two at this width and text size.
  const [hintHeight, setHintHeight] = useState(0);
  const [crossedHeight, setCrossedHeight] = useState(0);
  const onHintProbeLayout = useCallback((event: LayoutChangeEvent) => {
    setHintHeight(event.nativeEvent.layout.height);
  }, []);
  const onCrossedProbeLayout = useCallback((event: LayoutChangeEvent) => {
    setCrossedHeight(event.nativeEvent.layout.height);
  }, []);

  // How cleanly these corners would flatten into "Wall only" / "Holds only",
  // graded as each ring is released (`onChange` fires on release). Its own
  // slot, sized for the tallest grade, so a new grade never re-fits the photo.
  const qualityNote = useMemo(
    () => (invalid ? null : cornerQualityNote(value, qualityFrame)),
    [invalid, value, qualityFrame],
  );
  const [qualityHeights, setQualityHeights] = useState<Record<string, number>>({});
  const onQualityProbeLayout = useCallback((note: string, event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    setQualityHeights((previous) => (previous[note] === height ? previous : { ...previous, [note]: height }));
  }, []);
  const qualitySlotHeight = Math.max(0, ...Object.values(qualityHeights));

  // `predictCompressedSize` answers zeros for a picker that could not report a
  // size, and such a photo does reach this step. There is no pixel space to put
  // corners in, so say so; Back is in the header, and the add-a-wall flow can
  // still skip.
  const photoHasSize = photo.width > 0 && photo.height > 0;

  return (
    <ScrollView
      style={styles.flex}
      // The header inset is added by hand below: with `automatic`, iOS applies
      // it natively and the content could not be sized to the visible height.
      contentInsetAdjustmentBehavior="never"
      // Nothing is pinned under the page, so it pads only past the home indicator.
      contentContainerStyle={[
        styles.content,
        { paddingTop: headerInset + spacing[4], paddingBottom: bottomInset + spacing[3] },
      ]}
      {...fittedStage.scrollProps}
      bounces={false}
      showsVerticalScrollIndicator={false}
    >
      {stepCounter ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.stepCounter}>
          {stepCounter}
        </Text>
      ) : null}
      <Text variant="title3">{title}</Text>
      <Text variant="subheadline" color={systemColors.secondaryLabel}>
        {body}
      </Text>
      <View style={styles.clearRow}>
        <Button
          title={t('sprayWizard.anchors.clear')}
          icon="undo"
          variant="tonal"
          size="small"
          onPress={onClear}
          disabled={!canClear}
        />
      </View>
      <View style={styles.stage} onLayout={fittedStage.onStageLayout}>
        {photoHasSize ? (
          <SprayCornerMarker
            photo={photo}
            maxWidth={fittedStage.maxPhotoWidth}
            maxHeight={fittedStage.maxPhotoHeight}
            value={value}
            onChange={onChange}
            invalid={invalid}
            onDragActiveChange={fittedStage.onDragActiveChange}
          />
        ) : (
          <Text variant="subheadline" color={systemColors.error} style={styles.hint} accessibilityLiveRegion="polite">
            {t('sprayWizard.photo.failed')}
          </Text>
        )}
      </View>
      <View style={{ minHeight: Math.max(hintHeight, crossedHeight) }}>
        {/* The one announcement of a refusal, in both flows. */}
        <Text
          variant="footnote"
          color={invalid ? systemColors.error : systemColors.secondaryLabel}
          style={styles.hint}
          accessibilityLiveRegion={invalid ? 'polite' : 'none'}
        >
          {invalid ? t('sprayWizard.anchors.crossed') : t('sprayWizard.anchors.hint')}
        </Text>
        {/* Both sentences, laid out and never shown, so the slot can be sized
            before either is needed. */}
        <Text
          variant="footnote"
          style={[styles.hint, styles.hintProbe]}
          onLayout={onHintProbeLayout}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {t('sprayWizard.anchors.hint')}
        </Text>
        <Text
          variant="footnote"
          style={[styles.hint, styles.hintProbe]}
          onLayout={onCrossedProbeLayout}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {t('sprayWizard.anchors.crossed')}
        </Text>
      </View>
      {qualityFrame ? (
        <View style={{ minHeight: qualitySlotHeight }}>
          {qualityNote ? (
            <Text
              variant="footnote"
              color={qualityNote === 'good' ? systemColors.secondaryLabel : iosSystemColors.systemOrange}
              style={styles.hint}
              accessibilityLiveRegion="polite"
              testID={`spray-corner-quality-${qualityNote}`}
            >
              {t(`sprayWizard.anchors.quality.${qualityNote}`)}
            </Text>
          ) : null}
          {QUALITY_NOTES.map((note) => (
            <Text
              key={note}
              variant="footnote"
              style={[styles.hint, styles.hintProbe]}
              onLayout={(event) => onQualityProbeLayout(note, event)}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {t(`sprayWizard.anchors.quality.${note}`)}
            </Text>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing[4],
    gap: spacing[2],
  },
  clearRow: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  stepCounter: {
    textTransform: 'uppercase',
    marginBottom: spacing[1],
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
