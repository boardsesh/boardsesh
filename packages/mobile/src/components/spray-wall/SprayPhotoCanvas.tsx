import { useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useSharedValue, type SharedValue } from 'react-native-reanimated';
import type { ReactNode } from 'react';
import type { TnutPoint } from '@boardsesh/spray-wall-geometry';
import type { SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';
import { FlattenedSprayPhoto } from './FlattenedSprayPhoto';
import { fitCornerPhoto } from './corner-photo-fit';
import { useSprayPhotoViewport } from './use-spray-photo-viewport';

export type SprayPhotoCanvasProps = {
  source: SprayLookPreviewSource;
  photoUri: string;
  maxWidth: number;
  maxHeight: number;
  mode?: 'pan' | 'tap' | 'draw';
  onTap?: (point: TnutPoint, width: number, height: number) => void;
  onTrace?: (points: TnutPoint[], tolerance: number) => void;
  renderOverlay?: (width: number, height: number, zoom: SharedValue<number>) => ReactNode;
  onInteractionChange?: (active: boolean) => void;
};
const NO_FAILURES = [] as const;
export function SprayPhotoCanvas(props: SprayPhotoCanvasProps) {
  const fit = fitCornerPhoto({
    boxWidth: props.maxWidth,
    boxHeight: props.maxHeight,
    photoWidth: props.source.frame.width,
    photoHeight: props.source.frame.height,
  });
  if (!fit) return null;
  return <FittedCanvas {...props} width={fit.width} height={fit.height} />;
}
function FittedCanvas({
  source,
  photoUri,
  width,
  height,
  mode = 'pan',
  onTap,
  onTrace,
  renderOverlay,
  onInteractionChange,
}: SprayPhotoCanvasProps & { width: number; height: number }) {
  const { t } = useTranslation('boards');
  const viewport = useSprayPhotoViewport(width, height, onInteractionChange, mode !== 'draw', NO_FAILURES);
  const { zoom, panX, panY, isPinching, interactions, reportInteraction, pinchRef, viewportGesture, imageTransform } =
    viewport;
  const callbacks = useRef({ onTap, onTrace });
  callbacks.current = { onTap, onTrace };
  const commitTap = useCallback(
    (point: TnutPoint, scale: number) => callbacks.current.onTap?.(point, width * scale, height * scale),
    [width, height],
  );
  const commitTrace = useCallback(
    (points: TnutPoint[], tolerance: number) => callbacks.current.onTrace?.(points, tolerance),
    [],
  );
  const tapCancelled = useSharedValue(false);
  const trace = useSharedValue<TnutPoint[]>([]),
    drawing = useSharedValue(false),
    cancelled = useSharedValue(false);
  const actions = useMemo(() => {
    const pointAt = (x: number, y: number): TnutPoint => {
      'worklet';
      return {
        x: Math.max(0, Math.min(1, ((x - width / 2 - panX.value) / zoom.value + width / 2) / width)),
        y: Math.max(0, Math.min(1, ((y - height / 2 - panY.value) / zoom.value + height / 2) / height)),
      };
    };
    const tap = Gesture.Tap()
      .onBegin(() => {
        tapCancelled.value = false;
      })
      .onTouchesDown((event) => {
        if (event.numberOfTouches > 1) tapCancelled.value = true;
      })
      .onEnd((event, success) => {
        if (success && mode === 'tap' && !isPinching.value && !tapCancelled.value)
          runOnJS(commitTap)(pointAt(event.x, event.y), zoom.value);
      });
    const draw = Gesture.Pan()
      .maxPointers(1)
      .onTouchesDown((event) => {
        if (event.numberOfTouches > 1) cancelled.value = true;
      })
      .minDistance(0)
      .enabled(mode === 'draw')
      .simultaneousWithExternalGesture(pinchRef)
      .onStart((event) => {
        drawing.value = true;
        cancelled.value = false;
        trace.value = [pointAt(event.x, event.y)];
        interactions.value++;
        if (interactions.value === 1) runOnJS(reportInteraction)(true);
      })
      .onUpdate((event) => {
        if (isPinching.value) {
          cancelled.value = true;
          return;
        }
        const point = pointAt(event.x, event.y),
          last = trace.value.at(-1);
        if (!last || Math.hypot((point.x - last.x) * width, (point.y - last.y) * height) > 2 / zoom.value) {
          if (trace.value.length < 2000) trace.value = [...trace.value, point];
        }
      })
      .onEnd((event, success) => {
        if (success && !cancelled.value && !isPinching.value)
          runOnJS(commitTrace)(
            [...trace.value, pointAt(event.x, event.y)],
            14 / (Math.max(width, height) * zoom.value),
          );
      })
      .onFinalize(() => {
        if (!drawing.value) return;
        drawing.value = false;
        interactions.value--;
        if (interactions.value === 0) runOnJS(reportInteraction)(false);
      });
    return Gesture.Simultaneous(viewportGesture, Gesture.Exclusive(draw, tap));
  }, [
    mode,
    width,
    height,
    panX,
    panY,
    zoom,
    isPinching,
    commitTap,
    commitTrace,
    drawing,
    cancelled,
    trace,
    tapCancelled,
    interactions,
    reportInteraction,
    pinchRef,
    viewportGesture,
  ]);
  return (
    <GestureDetector gesture={actions}>
      <View
        style={{ width, height, overflow: 'hidden' }}
        collapsable={false}
        accessibilityLabel={t('sprayLedSetup.photoLabel')}
      >
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, imageTransform]}>
          <FlattenedSprayPhoto source={source} photoUri={photoUri} tile={{ width, height }} />
          {renderOverlay?.(width, height, zoom)}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
