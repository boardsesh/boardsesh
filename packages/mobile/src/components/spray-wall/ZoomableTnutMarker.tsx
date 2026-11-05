import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { tnutGridPath, type Quad } from '@boardsesh/spray-wall-geometry';
import { brandColorsDark } from '../../theme/colors';
import type { SprayCornerMarkerProps } from './SprayCornerMarker';
import {
  activeTnutCorners,
  clampViewportPan,
  cornerScreenCoordinate,
  draggedCornerCoordinate,
  focalZoomPan,
} from './tnut-corner-viewport';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const HANDLE_SIZE = 44;
const MAX_ZOOM = 6;

type FittedProps = SprayCornerMarkerProps & { renderWidth: number; renderHeight: number };

/** Keeps the cached, rectified photo and its grid under one UI-thread viewport transform. */
export function ZoomableTnutMarker({
  photo,
  value,
  onChange,
  onDragActiveChange,
  renderBackdrop,
  tnutGrid,
  edgeToEdge,
  invalid = false,
  renderWidth: width,
  renderHeight: height,
}: FittedProps) {
  const { t } = useTranslation('boards');
  const seed: Quad = value
    ? value.map(([x, y]) => [x / photo.width, y / photo.height])
    : [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
      ];
  const seedKey = seed.map(([x, y]) => `${x}:${y}`).join(';');
  const corners = useSharedValue<Quad>(seed);
  const zoom = useSharedValue(1);
  const panX = useSharedValue(0);
  const panY = useSharedValue(0);
  const isPinching = useSharedValue(false);
  const interactions = useSharedValue(0);
  const callbacks = useRef({ onChange, onDragActiveChange, photo });
  callbacks.current = { onChange, onDragActiveChange, photo };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      callbacks.current.onDragActiveChange?.(false);
    };
  }, []);
  useEffect(() => {
    corners.value = seed;
    // The scalar seed key prevents a scroll-lock re-render from resetting a held corner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);
  useEffect(() => {
    // Rotation changes the fitted viewport, never the canonical corner coordinates.
    zoom.value = 1;
    panX.value = 0;
    panY.value = 0;
  }, [width, height, zoom, panX, panY]);
  const commit = useCallback(() => {
    if (!mounted.current) return;
    const { photo: currentPhoto, onChange: change } = callbacks.current;
    change(corners.value.map(([x, y]) => [x * currentPhoto.width, y * currentPhoto.height]));
  }, [corners]);
  const reportInteraction = useCallback((active: boolean) => {
    if (mounted.current) callbacks.current.onDragActiveChange?.(active);
  }, []);
  const pinchRef = useRef<GestureType | undefined>(undefined);
  const firstHandleRef = useRef<GestureType | undefined>(undefined);
  const secondHandleRef = useRef<GestureType | undefined>(undefined);
  const thirdHandleRef = useRef<GestureType | undefined>(undefined);
  const fourthHandleRef = useRef<GestureType | undefined>(undefined);
  const handleRefs = useMemo(() => [firstHandleRef, secondHandleRef, thirdHandleRef, fourthHandleRef], []);
  const rows = tnutGrid?.rows ?? 8;
  const columns = tnutGrid?.columns ?? 8;
  const activeCorners = useMemo(() => activeTnutCorners(rows, columns), [rows, columns]);
  const pinchStartZoom = useSharedValue(1);
  const pinchStartX = useSharedValue(0);
  const pinchStartY = useSharedValue(0);
  const pinchFocalX = useSharedValue(0);
  const pinchFocalY = useSharedValue(0);
  const panStartX = useSharedValue(0);
  const panStartY = useSharedValue(0);
  const panActive = useSharedValue(false);
  const viewportGesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .withRef(pinchRef)
      .onTouchesDown((event) => {
        // Lock the page as soon as the second finger lands, before either
        // the native scroll view or a corner drag can consume its movement.
        if (event.numberOfTouches < 2 || isPinching.value) return;
        isPinching.value = true;
        interactions.value++;
        if (interactions.value === 1) runOnJS(reportInteraction)(true);
      })
      .onStart((event) => {
        if (!isPinching.value) {
          isPinching.value = true;
          interactions.value++;
          if (interactions.value === 1) runOnJS(reportInteraction)(true);
        }
        pinchStartZoom.value = zoom.value;
        pinchStartX.value = panX.value;
        pinchStartY.value = panY.value;
        pinchFocalX.value = event.focalX;
        pinchFocalY.value = event.focalY;
      })
      .onUpdate((event) => {
        const nextZoom = Math.max(1, Math.min(MAX_ZOOM, pinchStartZoom.value * event.scale));
        panX.value = focalZoomPan(
          pinchFocalX.value,
          event.focalX,
          width,
          pinchStartZoom.value,
          nextZoom,
          pinchStartX.value,
        );
        panY.value = focalZoomPan(
          pinchFocalY.value,
          event.focalY,
          height,
          pinchStartZoom.value,
          nextZoom,
          pinchStartY.value,
        );
        zoom.value = nextZoom;
      })
      .onFinalize(() => {
        if (!isPinching.value) return;
        isPinching.value = false;
        interactions.value--;
        if (interactions.value === 0) runOnJS(reportInteraction)(false);
      });
    const pan = Gesture.Pan()
      .maxPointers(1)
      .manualActivation(true)
      .onTouchesMove((_event, manager) => {
        // At fit scale, let the surrounding settings page scroll normally.
        if (zoom.value > 1 && !isPinching.value) manager.activate();
        else manager.fail();
      })
      .onStart(() => {
        panActive.value = true;
        panStartX.value = panX.value;
        panStartY.value = panY.value;
        interactions.value++;
        if (interactions.value === 1) runOnJS(reportInteraction)(true);
      })
      .onUpdate((event) => {
        if (isPinching.value) return;
        panX.value = clampViewportPan(panStartX.value + event.translationX, width, zoom.value);
        panY.value = clampViewportPan(panStartY.value + event.translationY, height, zoom.value);
      })
      .onFinalize(() => {
        if (!panActive.value) return;
        panActive.value = false;
        interactions.value--;
        if (interactions.value === 0) runOnJS(reportInteraction)(false);
      });
    pan.requireExternalGestureToFail(...activeCorners.map((corner) => handleRefs[corner]));
    return Gesture.Simultaneous(pinch, pan);
  }, [
    activeCorners,
    handleRefs,
    width,
    height,
    zoom,
    panX,
    panY,
    isPinching,
    interactions,
    reportInteraction,
    pinchStartZoom,
    pinchStartX,
    pinchStartY,
    pinchFocalX,
    pinchFocalY,
    panStartX,
    panStartY,
    panActive,
  ]);
  const imageTransform = useAnimatedStyle(() => ({
    transform: [{ translateX: panX.value }, { translateY: panY.value }, { scale: zoom.value }],
  }));
  const outlineProps = useAnimatedProps(() => {
    const active = activeTnutCorners(rows, columns);
    return {
      d:
        active.length < 2
          ? ''
          : active
              .map(
                (corner, index) =>
                  `${index === 0 ? 'M' : 'L'}${corners.value[corner][0] * width} ${corners.value[corner][1] * height}`,
              )
              .join('') + (active.length === 4 ? 'Z' : ''),
      strokeWidth: 1.5 / zoom.value,
      strokeDasharray: [6 / zoom.value, 5 / zoom.value],
    };
  });
  const gridProps = useAnimatedProps(() => ({
    d: tnutGrid
      ? tnutGridPath(
          {
            ...tnutGrid,
            corners: {
              topLeft: { x: corners.value[0][0], y: corners.value[0][1] },
              topRight: { x: corners.value[1][0], y: corners.value[1][1] },
              bottomRight: { x: corners.value[2][0], y: corners.value[2][1] },
              bottomLeft: { x: corners.value[3][0], y: corners.value[3][1] },
            },
          },
          width,
          height,
          3 / zoom.value,
        )
      : '',
    strokeWidth: 1 / zoom.value,
  }));
  const color = invalid ? brandColorsDark.error : brandColorsDark.tint;
  const labels = [
    t('sprayWizard.anchors.cornerTopLeft'),
    t('sprayWizard.anchors.cornerTopRight'),
    t('sprayWizard.anchors.cornerBottomRight'),
    t('sprayWizard.anchors.cornerBottomLeft'),
  ];
  return (
    <View style={{ padding: edgeToEdge ? 0 : HANDLE_SIZE / 2 }}>
      <GestureDetector gesture={viewportGesture}>
        <View style={{ width, height, overflow: 'hidden' }} collapsable={false}>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, imageTransform]}>
            {renderBackdrop ? (
              renderBackdrop(width, height)
            ) : (
              <Image source={{ uri: photo.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
            )}
            <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
              <AnimatedPath
                animatedProps={gridProps}
                fill={brandColorsDark.tint}
                stroke="rgba(0,0,0,0.4)"
                opacity={0.48}
              />
              <AnimatedPath animatedProps={outlineProps} stroke={color} fill="none" opacity={0.6} />
            </Svg>
          </Animated.View>
          {activeCorners.map((corner) => (
            <ZoomCorner
              key={corner}
              corner={corner}
              corners={corners}
              width={width}
              height={height}
              zoom={zoom}
              panX={panX}
              panY={panY}
              color={color}
              label={labels[corner]}
              commit={commit}
              handleRef={handleRefs[corner]}
              pinchRef={pinchRef}
              isPinching={isPinching}
              interactions={interactions}
              reportInteraction={reportInteraction}
            />
          ))}
        </View>
      </GestureDetector>
    </View>
  );
}

function ZoomCorner({
  corner,
  corners,
  width,
  height,
  zoom,
  panX,
  panY,
  color,
  label,
  commit,
  handleRef,
  pinchRef,
  isPinching,
  interactions,
  reportInteraction,
}: {
  corner: number;
  corners: SharedValue<Quad>;
  width: number;
  height: number;
  zoom: SharedValue<number>;
  panX: SharedValue<number>;
  panY: SharedValue<number>;
  color: string;
  label: string;
  commit: () => void;
  handleRef: MutableRefObject<GestureType | undefined>;
  pinchRef: MutableRefObject<GestureType | undefined>;
  isPinching: SharedValue<boolean>;
  interactions: SharedValue<number>;
  reportInteraction: (active: boolean) => void;
}) {
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const active = useSharedValue(false);
  const moved = useSharedValue(false);
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .withRef(handleRef)
        .maxPointers(1)
        .minDistance(0)
        .simultaneousWithExternalGesture(pinchRef)
        .onBegin(() => {
          startX.value = corners.value[corner][0];
          startY.value = corners.value[corner][1];
          moved.value = false;
          active.value = true;
          interactions.value++;
          if (interactions.value === 1) runOnJS(reportInteraction)(true);
        })
        .onUpdate((event) => {
          if (isPinching.value) return;
          const next: Quad = corners.value.map(([x, y]) => [x, y]);
          next[corner] = [
            draggedCornerCoordinate(startX.value, event.translationX, width, zoom.value),
            draggedCornerCoordinate(startY.value, event.translationY, height, zoom.value),
          ];
          corners.value = next;
          moved.value = true;
        })
        .onFinalize(() => {
          if (!active.value) return;
          // Persist the last visible drag even if a second finger transitions into a pinch.
          if (moved.value) runOnJS(commit)();
          active.value = false;
          interactions.value--;
          if (interactions.value === 0) runOnJS(reportInteraction)(false);
        }),
    [
      handleRef,
      pinchRef,
      corners,
      corner,
      width,
      height,
      zoom,
      isPinching,
      interactions,
      reportInteraction,
      commit,
      startX,
      startY,
      active,
      moved,
    ],
  );
  const ringProps = useAnimatedProps(() => ({
    cx: cornerScreenCoordinate(corners.value[corner][0], width, zoom.value, panX.value),
    cy: cornerScreenCoordinate(corners.value[corner][1], height, zoom.value, panY.value),
  }));
  const targetStyle = useAnimatedStyle(() => {
    const x = cornerScreenCoordinate(corners.value[corner][0], width, zoom.value, panX.value);
    const y = cornerScreenCoordinate(corners.value[corner][1], height, zoom.value, panY.value);
    return {
      // At an image boundary keep the whole touch target inside the viewport.
      left:
        x >= 0 && x <= width ? Math.max(0, Math.min(width - HANDLE_SIZE, x - HANDLE_SIZE / 2)) : x - HANDLE_SIZE / 2,
      top:
        y >= 0 && y <= height ? Math.max(0, Math.min(height - HANDLE_SIZE, y - HANDLE_SIZE / 2)) : y - HANDLE_SIZE / 2,
    };
  });
  return (
    <>
      <Svg pointerEvents="none" width={width} height={height} style={StyleSheet.absoluteFill}>
        <AnimatedCircle
          animatedProps={ringProps}
          r={14}
          fill="rgba(255,255,255,0.1)"
          stroke={color}
          strokeWidth={2}
          opacity={0.65}
        />
      </Svg>
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[styles.target, targetStyle]}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={label}
        />
      </GestureDetector>
    </>
  );
}

const styles = StyleSheet.create({ target: { position: 'absolute', width: HANDLE_SIZE, height: HANDLE_SIZE } });
