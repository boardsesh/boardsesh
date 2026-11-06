import { useMemo, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedProps, useSharedValue, type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import type { ReactNode } from 'react';
import type { TnutPoint } from '@boardsesh/spray-wall-geometry';
import type { SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';
import { FlattenedSprayPhoto } from './FlattenedSprayPhoto';
import { fitCornerPhoto } from './corner-photo-fit';
import { useSprayPhotoViewport } from './use-spray-photo-viewport';
import { nearestPhotoPointIndex } from './tnut-corner-viewport';

export type SprayPhotoCanvasProps = {
  source: SprayLookPreviewSource;
  photoUri: string;
  maxWidth: number;
  maxHeight: number;
  mode?: 'pan' | 'tap' | 'draw' | 'move';
  onTap?: (point: TnutPoint, width: number, height: number) => void;
  onTrace?: (points: TnutPoint[], tolerance: number) => void;
  onMove?: (start: TnutPoint, end: TnutPoint, width: number, height: number) => void;
  dragPoints?: TnutPoint[];
  draftColor?: string;
  renderOverlay?: (
    width: number,
    height: number,
    zoom: SharedValue<number>,
    panX: SharedValue<number>,
    panY: SharedValue<number>,
  ) => ReactNode;
  onInteractionChange?: (active: boolean) => void;
};
const NO_FAILURES = [] as const;
const AnimatedPath = Animated.createAnimatedComponent(Path);
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
  onMove,
  dragPoints,
  draftColor,
  renderOverlay,
  onInteractionChange,
}: SprayPhotoCanvasProps & { width: number; height: number }) {
  const { t } = useTranslation('boards');
  const editRef = useRef<GestureType | undefined>(undefined);
  const dragMode = mode === 'draw' || mode === 'move';
  const panFailures = useMemo(() => (dragMode ? [editRef] : NO_FAILURES), [dragMode]);
  const viewport = useSprayPhotoViewport(width, height, onInteractionChange, true, panFailures);
  const { zoom, panX, panY, isPinching, interactions, reportInteraction, pinchRef, viewportGesture, imageTransform } =
    viewport;
  const callbacks = useRef({ onTap, onTrace, onMove });
  callbacks.current = { onTap, onTrace, onMove };
  const commitTap = useCallback(
    (point: TnutPoint, scale: number) => callbacks.current.onTap?.(point, width * scale, height * scale),
    [width, height],
  );
  const commitTrace = useCallback(
    (points: TnutPoint[], tolerance: number) => callbacks.current.onTrace?.(points, tolerance),
    [],
  );
  const commitMove = useCallback(
    (start: TnutPoint, end: TnutPoint, scale: number) =>
      callbacks.current.onMove?.(start, end, width * scale, height * scale),
    [width, height],
  );
  const editablePoints = useSharedValue(dragPoints);
  useEffect(() => {
    editablePoints.value = dragPoints;
  }, [dragPoints, editablePoints]);
  const dragStart = useSharedValue<TnutPoint | null>(null);
  const draftPath = useSharedValue('');
  const draftProps = useAnimatedProps(() => ({ d: draftPath.value }));
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
        if (success && (mode === 'tap' || mode === 'draw') && !isPinching.value && !tapCancelled.value)
          runOnJS(commitTap)(pointAt(event.x, event.y), zoom.value);
      });
    const draw = Gesture.Pan()
      .withRef(editRef)
      .maxPointers(1)
      .onTouchesDown((event, manager) => {
        if (event.numberOfTouches > 1) {
          cancelled.value = true;
          return;
        }
        const touch = event.changedTouches[0];
        if (!touch) return;
        const origin = pointAt(touch.x, touch.y);
        dragStart.value = origin;
        // A drag beginning off the markers belongs to the photo pan.
        const points = editablePoints.value;
        if (!points) return;
        const scale = zoom.value;
        if (nearestPhotoPointIndex(points, origin, width * scale, height * scale, 22) < 0) manager.fail();
      })
      .minDistance(5)
      .enabled(dragMode)
      .simultaneousWithExternalGesture(pinchRef)
      .onStart((event) => {
        drawing.value = true;
        cancelled.value = false;
        trace.value = [dragStart.value ?? pointAt(event.x, event.y)];
        draftPath.value = `M${event.x} ${event.y}`;
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
        if (mode === 'move') {
          draftPath.value = `M${event.x - 6} ${event.y}a6 6 0 1 0 12 0a6 6 0 1 0 -12 0`;
          return;
        }
        if (!last || Math.hypot((point.x - last.x) * width, (point.y - last.y) * height) > 2 / zoom.value) {
          if (trace.value.length < 2000) {
            trace.modify((points) => {
              points.push(point);
              return points;
            });
            draftPath.value += `L${event.x} ${event.y}`;
          }
        }
      })
      .onEnd((event, success) => {
        if (!success || cancelled.value || isPinching.value) return;
        const end = pointAt(event.x, event.y);
        if (mode === 'move') {
          const start = trace.value[0];
          if (start) runOnJS(commitMove)(start, end, zoom.value);
        } else {
          runOnJS(commitTrace)([...trace.value, end], 14 / (Math.max(width, height) * zoom.value));
        }
      })
      .onFinalize(() => {
        draftPath.value = '';
        dragStart.value = null;
        if (!drawing.value) return;
        drawing.value = false;
        interactions.value--;
        if (interactions.value === 0) runOnJS(reportInteraction)(false);
      });
    return Gesture.Simultaneous(viewportGesture, Gesture.Exclusive(draw, tap));
  }, [
    mode,
    dragMode,
    width,
    height,
    panX,
    panY,
    zoom,
    isPinching,
    commitTap,
    commitTrace,
    commitMove,
    editablePoints,
    dragStart,
    draftPath,
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
        </Animated.View>
        {renderOverlay?.(width, height, zoom, panX, panY)}
        {draftColor && dragMode ? (
          <Svg pointerEvents="none" width={width} height={height} style={StyleSheet.absoluteFill}>
            <AnimatedPath animatedProps={draftProps} fill="none" stroke={draftColor} strokeWidth={2} />
          </Svg>
        ) : null}
      </View>
    </GestureDetector>
  );
}
