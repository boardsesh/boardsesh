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

import { useCallback, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Quad } from '@boardsesh/spray-wall-geometry';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useTransparentHeaderInset } from '../../hooks/use-transparent-header-inset';
import { spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { SprayCornerMarker } from './SprayCornerMarker';
import { CORNER_HANDLE_SIZE } from './corner-photo-fit';

/** Widest the photo is ever drawn. Past this it is a wall on a coffee table. */
const MAX_PHOTO_WIDTH = 520;

/** The shortest the photo's slot is ever made, however little room the screen leaves. */
const MIN_STAGE_HEIGHT = 200 + CORNER_HANDLE_SIZE;

/** Layout jitter smaller than this is not worth re-fitting the photo for. */
const LAYOUT_EPSILON = 0.5;

type Size = { width: number; height: number };
const NO_SIZE: Size = { width: 0, height: 0 };

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

  const [stage, setStage] = useState<Size>(NO_SIZE);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);

  const onStageLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setStage((previous) =>
      Math.abs(previous.width - width) < LAYOUT_EPSILON && Math.abs(previous.height - height) < LAYOUT_EPSILON
        ? previous
        : { width, height },
    );
  }, []);
  const onViewportLayout = useCallback((event: LayoutChangeEvent) => {
    setViewportHeight(event.nativeEvent.layout.height);
  }, []);
  const onContentSizeChange = useCallback((_width: number, height: number) => {
    setContentHeight(height);
  }, []);

  // Scrolls only when the content really is taller than the screen — that is,
  // only when the stage has hit its floor.
  const overflows = contentHeight > viewportHeight + LAYOUT_EPSILON;

  // And never while a ring is held. Counted, because two rings can be held at
  // once and the page must stay put until the last finger lifts. The marker
  // reports a finger landing and leaving, so this is two state changes per drag.
  const heldHandles = useRef(0);
  const [dragging, setDragging] = useState(false);
  const onDragActiveChange = useCallback((active: boolean) => {
    heldHandles.current = Math.max(0, heldHandles.current + (active ? 1 : -1));
    setDragging(heldHandles.current > 0);
  }, []);

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

  // The stage runs edge to edge so the handle layer, which overhangs the photo
  // by half a handle on every side, has room. For a photo limited by its width
  // the layer is still 12 points wider than the stage (the gutter is 16, the
  // overhang 22), so 6 points of each outer touch target fall outside it, off
  // the edge of the screen. The rings themselves are whole.
  // Floored at zero: before the stage is measured these would be negative, and
  // "no room yet" should not depend on every reader treating that as zero.
  const maxPhotoWidth = Math.max(0, Math.min(MAX_PHOTO_WIDTH, stage.width - spacing[4] * 2));
  const maxPhotoHeight = Math.max(0, stage.height - CORNER_HANDLE_SIZE);

  return (
    <ScrollView
      style={styles.flex}
      // The header inset is added by hand below: with `automatic`, iOS applies
      // it natively and the content could not be sized to the visible height.
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={[styles.content, { paddingTop: headerInset + spacing[4] }]}
      scrollEnabled={overflows && !dragging}
      bounces={false}
      showsVerticalScrollIndicator={false}
      onLayout={onViewportLayout}
      onContentSizeChange={onContentSizeChange}
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
      <View style={styles.stage} onLayout={onStageLayout}>
        {photoHasSize ? (
          <SprayCornerMarker
            photo={photo}
            maxWidth={maxPhotoWidth}
            maxHeight={maxPhotoHeight}
            value={value}
            onChange={onChange}
            invalid={invalid}
            onDragActiveChange={onDragActiveChange}
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
