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
// Nothing under the photo changes height either. The hint and the "those
// corners cross over" sentence that replaces it share one slot, sized for the
// taller of the two, so a refused quad does not re-fit the photo as the finger
// lifts.

import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Quad } from '@boardsesh/spray-wall-geometry';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useTransparentHeaderInset } from '../../hooks/use-transparent-header-inset';
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
};

export function SprayCornerStep({ stepCounter, title, body, photo, value, onChange, invalid }: SprayCornerStepProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const headerInset = useTransparentHeaderInset();

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

  // `predictCompressedSize` answers zeros for a picker that could not report a
  // size, and such a photo does reach this step. There is no pixel space to put
  // corners in, so say so; Back is in the footer, and the add-a-wall flow can
  // still skip.
  const photoHasSize = photo.width > 0 && photo.height > 0;

  return (
    <ScrollView
      style={styles.flex}
      // The header inset is added by hand below: with `automatic`, iOS applies
      // it natively and the content could not be sized to the visible height.
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={[styles.content, { paddingTop: headerInset + spacing[4] }]}
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
          <Text
            variant="subheadline"
            color={iosSystemColors.systemRed}
            style={styles.hint}
            accessibilityLiveRegion="polite"
          >
            {t('sprayWizard.photo.failed')}
          </Text>
        )}
      </View>
      <View style={{ minHeight: Math.max(hintHeight, crossedHeight) }}>
        {/* The one announcement of a refusal, in both flows. */}
        <Text
          variant="footnote"
          color={invalid ? iosSystemColors.systemRed : systemColors.secondaryLabel}
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
    paddingBottom: spacing[3],
    gap: spacing[2],
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
