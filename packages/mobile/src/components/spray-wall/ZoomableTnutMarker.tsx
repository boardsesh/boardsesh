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
import { useSprayPhotoViewport } from './use-spray-photo-viewport';
import { brandColorsDark } from '../../theme/colors';
import type { SprayCornerMarkerProps } from './SprayCornerMarker';
import { activeTnutCorners, cornerScreenCoordinate, draggedCornerCoordinate } from './tnut-corner-viewport';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const HANDLE_SIZE = 44;

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

  const commit = useCallback(() => {
    if (!mounted.current) return;
    const { photo: currentPhoto, onChange: change } = callbacks.current;
    change(corners.value.map(([x, y]) => [x * currentPhoto.width, y * currentPhoto.height]));
  }, [corners]);
  const firstHandleRef = useRef<GestureType | undefined>(undefined);
  const secondHandleRef = useRef<GestureType | undefined>(undefined);
  const thirdHandleRef = useRef<GestureType | undefined>(undefined);
  const fourthHandleRef = useRef<GestureType | undefined>(undefined);
  const handleRefs = useMemo(() => [firstHandleRef, secondHandleRef, thirdHandleRef, fourthHandleRef], []);
  const rows = tnutGrid?.rows ?? 8;
  const columns = tnutGrid?.columns ?? 8;
  const activeCorners = useMemo(() => activeTnutCorners(rows, columns), [rows, columns]);
  const failures = useMemo(() => activeCorners.map((corner) => handleRefs[corner]), [activeCorners, handleRefs]);
  const { zoom, panX, panY, isPinching, interactions, reportInteraction, pinchRef, viewportGesture, imageTransform } =
    useSprayPhotoViewport(width, height, onDragActiveChange, true, failures);
  const outlineProps = useAnimatedProps(() => {
    const active = activeTnutCorners(rows, columns);
    let path = '';
    if (active.length >= 2) {
      for (const corner of active) {
        const x = cornerScreenCoordinate(corners.value[corner][0], width, zoom.value, panX.value);
        const y = cornerScreenCoordinate(corners.value[corner][1], height, zoom.value, panY.value);
        path += `${path ? 'L' : 'M'}${x} ${y}`;
      }
      if (active.length === 4) path += 'Z';
    }
    return {
      d: path,
      strokeWidth: 1.5,
      strokeDasharray: [6, 5],
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
          width * zoom.value,
          height * zoom.value,
          4,
          cornerScreenCoordinate(0, width, zoom.value, panX.value),
          cornerScreenCoordinate(0, height, zoom.value, panY.value),
        )
      : '',
    strokeWidth: 2,
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
          </Animated.View>
          <Svg pointerEvents="none" width={width} height={height} style={StyleSheet.absoluteFill}>
            <AnimatedPath animatedProps={outlineProps} stroke={color} fill="none" opacity={0.6} />
            <AnimatedPath
              animatedProps={gridProps}
              fill={brandColorsDark.tint}
              stroke="rgba(0,0,0,0.4)"
              opacity={0.95}
            />
          </Svg>
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
