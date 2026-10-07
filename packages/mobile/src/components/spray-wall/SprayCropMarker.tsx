// Drag a crop box over the wall photo (the photo step's "Crop or rotate").
//
// The sibling of `SprayCornerMarker`, and built the same way for the same
// reasons: the photo is fitted on both axes inside the space it is given
// (`corner-photo-fit.ts`), the handle layer overhangs it by half a handle so a
// handle on the photo's edge is whole and touchable, and a drag is a worklet-only
// operation that crosses to JS once, when the finger lifts.
//
// Eight handles — four corners, four edges — plus the box itself, which moves
// without changing size. Free aspect ratio. The box lives in FOUR shared values
// holding FRACTIONS of the photo, not points: a re-fit (a rotated phone, a hint
// that wraps) then needs no carrying across at all, and the edges are already in
// the unit the edit is stored in. `dragCropEdges` is the whole of the movement
// rule.
//
// The photo it is handed is the one on screen, already rotated by the step
// (`renderRotatedPreview`): a view transform would hand pan translations back in
// rotated axes.

import { useCallback, useEffect, useMemo, useRef, type ComponentProps } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { borderRadius } from '../../theme/tokens';
import type { NormalizedRect } from '../../lib/spray/photo-edit';
import { CORNER_HANDLE_SIZE, cornerLayerLayout, fitCornerPhoto } from './corner-photo-fit';
import { CROP_RESIZE_HANDLES, dragCropEdges, type CropEdges, type CropHandle } from './crop-box-math';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** The visible knob inside a corner's touch target. */
const CORNER_KNOB_SIZE = 22;
/** The visible bar inside an edge's touch target. */
const EDGE_BAR_LENGTH = 24;
const EDGE_BAR_THICKNESS = 5;
/** How much of the photo outside the crop is dimmed. Enough to read the wall's edge against it. */
const DIM_OPACITY = 0.55;

const CROP_COLOR = '#FFFFFF';

export type SprayCropMarkerProps = {
  /** The photo as it is drawn: the rotated preview's URI, at the rotated base's size. */
  photo: { uri: string; width: number; height: number };
  /** Widest the photo may be drawn. */
  maxWidth: number;
  /** Tallest the photo may be drawn. The photo is fitted inside both, never cropped. */
  maxHeight: number;
  /** The crop to show, as fractions of `photo`. */
  value: NormalizedRect;
  /** Fired when a handle or the box is released, with the crop as fractions of `photo`. */
  onChange: (rect: NormalizedRect) => void;
  /** The smallest the box may be, as fractions of `photo`'s width and height. */
  minSize: { width: number; height: number };
  /** Fired when a finger lands on a handle and again when it lets go — twice per drag, never per frame. */
  onDragActiveChange?: (active: boolean) => void;
};

export function SprayCropMarker(props: SprayCropMarkerProps) {
  const { photo, maxWidth, maxHeight } = props;
  const fit = useMemo(
    () =>
      fitCornerPhoto({ boxWidth: maxWidth, boxHeight: maxHeight, photoWidth: photo.width, photoHeight: photo.height }),
    [maxWidth, maxHeight, photo.width, photo.height],
  );
  // Nothing until there is a real frame: every handle is placed through the
  // frame's size, and a zero-sized one would put all eight on top of each other.
  if (!fit) return null;
  return <FittedCropMarker {...props} renderWidth={fit.width} renderHeight={fit.height} />;
}

function FittedCropMarker({
  photo,
  value,
  onChange,
  minSize,
  onDragActiveChange,
  renderWidth,
  renderHeight,
}: SprayCropMarkerProps & { renderWidth: number; renderHeight: number }) {
  const { t } = useTranslation('boards');

  const left = useSharedValue(value.left);
  const top = useSharedValue(value.top);
  const right = useSharedValue(value.right);
  const bottom = useSharedValue(value.bottom);

  // `useSharedValue` reads its seed once. A new value — Reset, a quarter turn —
  // has to be written in, keyed on the numbers so a re-render that rebuilds the
  // same rectangle does not yank a handle from under a finger.
  const valueKey = `${value.left},${value.top},${value.right},${value.bottom}`;
  const appliedKey = useRef(valueKey);
  useEffect(() => {
    if (appliedKey.current === valueKey) return;
    appliedKey.current = valueKey;
    left.value = value.left;
    top.value = value.top;
    right.value = value.right;
    bottom.value = value.bottom;
    // `valueKey` stands in for `value`; the shared values never change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  // The callbacks as of the latest render, so the gestures (built once per fit)
  // never have to be rebuilt because a parent passed a new closure. Same reason
  // as `SprayCornerMarker`: a pan swapped out under a finger drops the drag.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onDragActiveChangeRef = useRef(onDragActiveChange);
  onDragActiveChangeRef.current = onDragActiveChange;

  /** Read the box and report it. Once per drag, from `onEnd`; nothing is writing the values by then. */
  const commit = useCallback(() => {
    onChangeRef.current({ left: left.value, top: top.value, right: right.value, bottom: bottom.value });
  }, [left, top, right, bottom]);

  const reportDragActive = useCallback((active: boolean) => {
    onDragActiveChangeRef.current?.(active);
  }, []);

  // Everything outside the box, dimmed: the frame and the box as two subpaths
  // filled even-odd, so the box is a hole. Follows a drag on the UI thread.
  const dimProps = useAnimatedProps(() => {
    'worklet';
    const boxLeft = left.value * renderWidth;
    const boxTop = top.value * renderHeight;
    const boxRight = right.value * renderWidth;
    const boxBottom = bottom.value * renderHeight;
    return {
      d: `M0 0H${renderWidth}V${renderHeight}H0Z` + `M${boxLeft} ${boxTop}H${boxRight}V${boxBottom}H${boxLeft}Z`,
    };
  });

  const layout = cornerLayerLayout({ width: renderWidth, height: renderHeight });

  // The box's own outline, and the surface that moves it.
  const boxStyle = useAnimatedStyle(() => ({
    left: layout.frame.left + left.value * renderWidth,
    top: layout.frame.top + top.value * renderHeight,
    width: (right.value - left.value) * renderWidth,
    height: (bottom.value - top.value) * renderHeight,
  }));

  // Written out rather than looked up by key: the i18n linter only accepts
  // literal keys.
  const handleLabels: Record<CropHandle, string> = {
    topLeft: t('sprayWizard.adjust.handleTopLeft'),
    top: t('sprayWizard.adjust.handleTop'),
    topRight: t('sprayWizard.adjust.handleTopRight'),
    right: t('sprayWizard.adjust.handleRight'),
    bottomRight: t('sprayWizard.adjust.handleBottomRight'),
    bottom: t('sprayWizard.adjust.handleBottom'),
    bottomLeft: t('sprayWizard.adjust.handleBottomLeft'),
    left: t('sprayWizard.adjust.handleLeft'),
    move: t('sprayWizard.adjust.handleMove'),
  };

  // One object for the life of the marker: the pans list it as a dependency.
  const edges = useMemo(() => ({ left, top, right, bottom }), [left, top, right, bottom]);

  return (
    <View style={layout.layer}>
      <View style={[styles.frame, layout.frame, { borderRadius: borderRadius.lg }]}>
        <Image
          source={{ uri: photo.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          accessibilityIgnoresInvertColors
        />
      </View>
      <Svg pointerEvents="none" style={[styles.overlay, layout.frame]} width={renderWidth} height={renderHeight}>
        <AnimatedPath animatedProps={dimProps} fill="#000000" fillOpacity={DIM_OPACITY} fillRule="evenodd" />
      </Svg>
      <CropGestureSurface
        handle="move"
        edges={edges}
        renderWidth={renderWidth}
        renderHeight={renderHeight}
        minSize={minSize}
        onDragActiveChange={reportDragActive}
        onCommit={commit}
        label={handleLabels.move}
        style={[styles.box, boxStyle]}
      />
      {CROP_RESIZE_HANDLES.map((handle) => (
        <CropResizeHandle
          key={handle}
          handle={handle}
          edges={edges}
          renderWidth={renderWidth}
          renderHeight={renderHeight}
          minSize={minSize}
          offset={layout.handleOffset}
          onDragActiveChange={reportDragActive}
          onCommit={commit}
          label={handleLabels[handle]}
        />
      ))}
    </View>
  );
}

type CropEdgeValues = {
  left: SharedValue<number>;
  top: SharedValue<number>;
  right: SharedValue<number>;
  bottom: SharedValue<number>;
};

type CropGestureProps = {
  handle: CropHandle;
  edges: CropEdgeValues;
  renderWidth: number;
  renderHeight: number;
  minSize: { width: number; height: number };
  /** Stable for the life of the marker. */
  onDragActiveChange: (active: boolean) => void;
  /** Stable for the life of the marker. */
  onCommit: () => void;
  label: string;
};

/** One pan that drives the box through `dragCropEdges`, from where it was when the finger landed. */
function useCropPan({
  handle,
  edges,
  renderWidth,
  renderHeight,
  minSize,
  onDragActiveChange,
  onCommit,
}: Omit<CropGestureProps, 'label'>) {
  const startLeft = useSharedValue(0);
  const startTop = useSharedValue(0);
  const startRight = useSharedValue(1);
  const startBottom = useSharedValue(1);
  const minWidth = minSize.width;
  const minHeight = minSize.height;

  return useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          startLeft.value = edges.left.value;
          startTop.value = edges.top.value;
          startRight.value = edges.right.value;
          startBottom.value = edges.bottom.value;
          runOnJS(onDragActiveChange)(true);
        })
        .onUpdate((event) => {
          // Translations arrive in points; the box is in fractions of the photo.
          const start: CropEdges = {
            left: startLeft.value,
            top: startTop.value,
            right: startRight.value,
            bottom: startBottom.value,
          };
          const next = dragCropEdges(
            start,
            handle,
            event.translationX / renderWidth,
            event.translationY / renderHeight,
            { width: 1, height: 1 },
            { width: minWidth, height: minHeight },
          );
          edges.left.value = next.left;
          edges.top.value = next.top;
          edges.right.value = next.right;
          edges.bottom.value = next.bottom;
        })
        .onEnd(() => {
          runOnJS(onCommit)();
        })
        // Always follows `onBegin`, including for a touch that never became a drag.
        .onFinalize(() => {
          runOnJS(onDragActiveChange)(false);
        }),
    // Shared values and the marker's ref-backed callbacks never change identity;
    // the sizes change only when the photo is re-fitted or turned.
    [
      handle,
      edges,
      startLeft,
      startTop,
      startRight,
      startBottom,
      renderWidth,
      renderHeight,
      minWidth,
      minHeight,
      onDragActiveChange,
      onCommit,
    ],
  );
}

function CropGestureSurface({
  style,
  label,
  ...gestureProps
}: CropGestureProps & { style: ComponentProps<typeof Animated.View>['style'] }) {
  const pan = useCropPan(gestureProps);
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={style} accessible accessibilityRole="adjustable" accessibilityLabel={label} />
    </GestureDetector>
  );
}

/** Where a handle sits on the box, as fractions read from the four edges. */
function handlePoint(handle: CropHandle, edges: CropEdgeValues): { x: number; y: number } {
  'worklet';
  const midX = (edges.left.value + edges.right.value) / 2;
  const midY = (edges.top.value + edges.bottom.value) / 2;
  switch (handle) {
    case 'topLeft':
      return { x: edges.left.value, y: edges.top.value };
    case 'top':
      return { x: midX, y: edges.top.value };
    case 'topRight':
      return { x: edges.right.value, y: edges.top.value };
    case 'right':
      return { x: edges.right.value, y: midY };
    case 'bottomRight':
      return { x: edges.right.value, y: edges.bottom.value };
    case 'bottom':
      return { x: midX, y: edges.bottom.value };
    case 'bottomLeft':
      return { x: edges.left.value, y: edges.bottom.value };
    case 'left':
      return { x: edges.left.value, y: midY };
    default:
      return { x: midX, y: midY };
  }
}

function CropResizeHandle({ offset, label, ...gestureProps }: CropGestureProps & { offset: number }) {
  const { handle, edges, renderWidth, renderHeight } = gestureProps;
  const pan = useCropPan(gestureProps);

  // Placed exactly as `SprayCornerMarker` places a ring: a render point on the
  // frame plus the layer's offset gives the handle's own top-left.
  const style = useAnimatedStyle(() => {
    const point = handlePoint(handle, edges);
    return {
      transform: [{ translateX: point.x * renderWidth + offset }, { translateY: point.y * renderHeight + offset }],
    };
  });

  const isCorner = handle === 'topLeft' || handle === 'topRight' || handle === 'bottomRight' || handle === 'bottomLeft';
  const isVerticalEdge = handle === 'left' || handle === 'right';

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[styles.handle, style]}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
      >
        <View
          style={isCorner ? styles.cornerKnob : isVerticalEdge ? styles.edgeBarVertical : styles.edgeBarHorizontal}
        />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  frame: {
    position: 'absolute',
    overflow: 'hidden',
    backgroundColor: '#000000',
  },
  overlay: {
    position: 'absolute',
  },
  box: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: CROP_COLOR,
  },
  handle: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: CORNER_HANDLE_SIZE,
    height: CORNER_HANDLE_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cornerKnob: {
    width: CORNER_KNOB_SIZE,
    height: CORNER_KNOB_SIZE,
    borderRadius: CORNER_KNOB_SIZE / 2,
    borderWidth: 3,
    borderColor: CROP_COLOR,
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
  },
  edgeBarHorizontal: {
    width: EDGE_BAR_LENGTH,
    height: EDGE_BAR_THICKNESS,
    borderRadius: EDGE_BAR_THICKNESS / 2,
    backgroundColor: CROP_COLOR,
  },
  edgeBarVertical: {
    width: EDGE_BAR_THICKNESS,
    height: EDGE_BAR_LENGTH,
    borderRadius: EDGE_BAR_THICKNESS / 2,
    backgroundColor: CROP_COLOR,
  },
});
