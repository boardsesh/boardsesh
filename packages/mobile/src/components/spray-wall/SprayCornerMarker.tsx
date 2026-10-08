// Mark the wall's four corners on the photo (epic #5346, SW-09).
//
// Optional, and "Skip" is the default. With no anchors the canonical frame is the
// photo's own pixel box, which is right for a wall shot square on — and a wall
// shot square on is what the guidance copy asks for. What the anchors buy is the
// NEXT photo: a wall reset months later is photographed from a slightly different
// spot, and the two photos only agree about where a hold is if each carries a
// quad naming the same four points on the real wall.
//
// Four independent handles rather than one draggable quad, because the gesture
// that matters is "that corner is a bit left of where you put it". Each handle
// owns a shared value and a pan; nothing crosses to JS until the finger lifts, so
// dragging a corner is a worklet-only operation and the screen does not re-render
// per frame.
//
// Coordinates on screen are RENDER pixels, measured from the top-left of the
// photo's frame. The frame is the photo fitted inside the space it is given, on
// both axes, so all four rings are on screen at once (`corner-photo-fit.ts`).
// Coordinates leaving this component are PHOTO pixels, which is what
// `createSprayWallVersion` stores and what the homography is solved in.

import { useCallback, useEffect, useMemo, useRef } from 'react';
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
import type { Quad } from '@boardsesh/spray-wall-geometry';
import { borderRadius } from '../../theme/tokens';
import { brandColorsDark } from '../../theme/colors';
import {
  CORNER_HANDLE_SIZE,
  cornerLayerLayout,
  fitCornerPhoto,
  planCornerRefit,
  quadToPhoto,
  quadToRender,
  rescaleRenderCoordinate,
} from './corner-photo-fit';

const AnimatedPath = Animated.createAnimatedComponent(Path);

const HANDLE_SIZE = CORNER_HANDLE_SIZE;
/** The visible ring inside that target. */
const RING_SIZE = 28;

/**
 * How far in from each edge an unmarked quad starts.
 *
 * Not the exact corners: a quad already sitting on the photo's edge looks
 * finished, and the whole point of this step is that the climber MOVES the four
 * points onto the wall. A tenth of the frame reads as "these are a guess".
 */
const DEFAULT_INSET = 0.1;

export type SprayCornerMarkerProps = {
  photo: { uri: string; width: number; height: number };
  /** Widest the photo may be drawn. */
  maxWidth: number;
  /** Tallest the photo may be drawn. The photo is fitted inside both, never cropped. */
  maxHeight: number;
  /** The quad to open with, in photo pixels, or null to start from the default inset. */
  value: Quad | null;
  /** Fired when a corner is released, with all four in photo pixels, TL/TR/BR/BL. */
  onChange: (quad: Quad) => void;
  /** True once the quad has been refused for crossing itself; paints the guides red. */
  invalid?: boolean;
  /**
   * Fired when a finger lands on a handle and again when it lets go — twice per
   * drag, never per frame. Lets a scrolling parent hold still while a ring is
   * being moved.
   */
  onDragActiveChange?: (active: boolean) => void;
};

const CORNER_ORDER = [0, 1, 2, 3] as const;

/** The default quad, in photo pixels, TL/TR/BR/BL. */
function defaultQuad(width: number, height: number): Quad {
  const insetX = width * DEFAULT_INSET;
  const insetY = height * DEFAULT_INSET;
  return [
    [insetX, insetY],
    [width - insetX, insetY],
    [width - insetX, height - insetY],
    [insetX, height - insetY],
  ];
}

export function SprayCornerMarker(props: SprayCornerMarkerProps) {
  const { photo, maxWidth, maxHeight } = props;
  const fit = useMemo(
    () =>
      fitCornerPhoto({ boxWidth: maxWidth, boxHeight: maxHeight, photoWidth: photo.width, photoHeight: photo.height }),
    [maxWidth, maxHeight, photo.width, photo.height],
  );
  // Nothing until there is a real frame. The rings are seeded through the fit's
  // scale, and `useSharedValue` reads its seed exactly once — mounting them
  // against a zero-sized box would seed all eight from a division by zero.
  // (A photo with no size never gets here: `SprayCornerStep` says so instead.)
  if (!fit) return null;
  return <FittedCornerMarker {...props} renderWidth={fit.width} renderHeight={fit.height} renderScale={fit.scale} />;
}

function FittedCornerMarker({
  photo,
  value,
  onChange,
  invalid = false,
  onDragActiveChange,
  renderWidth,
  renderHeight,
  renderScale,
}: SprayCornerMarkerProps & {
  renderWidth: number;
  renderHeight: number;
  /** Render points per photo pixel, the same on both axes. */
  renderScale: number;
}) {
  const { t } = useTranslation('boards');

  const seed = useMemo(() => value ?? defaultQuad(photo.width, photo.height), [value, photo.width, photo.height]);
  const renderSeed = quadToRender(seed, renderScale);

  // Four handles, four pairs of shared values. Written unrolled because hooks
  // cannot be called in a loop whose length could ever change — and this one
  // cannot, which is exactly why unrolling costs nothing.
  const x0 = useSharedValue(renderSeed[0][0]);
  const y0 = useSharedValue(renderSeed[0][1]);
  const x1 = useSharedValue(renderSeed[1][0]);
  const y1 = useSharedValue(renderSeed[1][1]);
  const x2 = useSharedValue(renderSeed[2][0]);
  const y2 = useSharedValue(renderSeed[2][1]);
  const x3 = useSharedValue(renderSeed[3][0]);
  const y3 = useSharedValue(renderSeed[3][1]);

  const xs = useMemo(() => [x0, x1, x2, x3], [x0, x1, x2, x3]);
  const ys = useMemo(() => [y0, y1, y2, y3], [y0, y1, y2, y3]);

  /**
   * Put the handles back where the seed says.
   *
   * `useSharedValue(initial)` reads its argument ONCE, on the first render, and
   * ignores it forever after. So "Clear" recalculated the seed to the default
   * inset quad and changed the button's label while the four rings stayed exactly
   * where they had been dragged — and the concrete failure was worse than
   * cosmetic: a climber who crossed the corners, tapped Clear and dragged one
   * handle re-committed the same crossed quad and met the same refusal, with no
   * way out but moving all four by hand.
   *
   * Keyed on the seed's VALUES rather than its identity, so a re-render that
   * rebuilds the same quad does not yank a handle out from under a finger.
   *
   * A re-fit with the SAME seed is a different event and gets a different
   * answer: the frame changed size (a rotation, a hint that wrapped onto a second
   * line), so every ring is carried to the same point of the photo at the new
   * scale. Re-seeding there would throw away a quad that was dragged, refused for
   * crossing itself and so never saved — the rings would jump back under the
   * very message telling the climber to fix them.
   */
  const seedKey = seed.map(([pointX, pointY]) => `${pointX},${pointY}`).join(';');
  const applied = useRef({ seedKey, scale: renderScale });
  useEffect(() => {
    const previous = applied.current;
    const next = { seedKey, scale: renderScale };
    applied.current = next;
    const plan = planCornerRefit(previous, next);
    if (plan === 'seed') {
      for (const [corner, [pointX, pointY]] of quadToRender(seed, renderScale).entries()) {
        xs[corner].value = pointX;
        ys[corner].value = pointY;
      }
    } else if (plan === 'rescale') {
      for (const corner of CORNER_ORDER) {
        xs[corner].value = rescaleRenderCoordinate(xs[corner].value, previous.scale, renderScale);
        ys[corner].value = rescaleRenderCoordinate(ys[corner].value, previous.scale, renderScale);
      }
    }
    // `seedKey` stands in for `seed`, and `xs` / `ys` are stable arrays of stable
    // shared values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey, renderScale]);

  // The callbacks and the scale, as of the latest render, for the two functions
  // below to read. Both of those are handed to the gestures, and a gesture
  // object must not be rebuilt because a parent re-rendered: the page's scroll
  // lock is a state change on finger-down, the screen passes `onChange` as a new
  // closure every render, and a pan swapped out from under a finger is not
  // something worth finding out about. With these in refs the two functions
  // never change identity, so the gestures are built once per fit.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onDragActiveChangeRef = useRef(onDragActiveChange);
  onDragActiveChangeRef.current = onDragActiveChange;
  const renderScaleRef = useRef(renderScale);
  renderScaleRef.current = renderScale;

  /**
   * Read all four handles and report them in photo pixels.
   *
   * Called from a gesture's `onEnd` through `runOnJS`, once per drag — never per
   * frame. Reading the other three shared values from JS is safe here for the
   * same reason: by the time this runs, no worklet is writing them.
   */
  const commit = useCallback(() => {
    onChangeRef.current(
      quadToPhoto(
        [
          [x0.value, y0.value],
          [x1.value, y1.value],
          [x2.value, y2.value],
          [x3.value, y3.value],
        ],
        renderScaleRef.current,
      ),
    );
  }, [x0, y0, x1, y1, x2, y2, x3, y3]);

  /** A finger landed on a handle, or left it. Twice per drag, never per frame. */
  const reportDragActive = useCallback((active: boolean) => {
    onDragActiveChangeRef.current?.(active);
  }, []);

  // The marked area, drawn between the four rings. A worklet reading the same
  // shared values the handles write, so it follows a drag on the UI thread and
  // the screen still does not re-render per frame.
  const outlineProps = useAnimatedProps(() => {
    'worklet';
    return {
      d: `M${x0.value} ${y0.value}L${x1.value} ${y1.value}L${x2.value} ${y2.value}L${x3.value} ${y3.value}Z`,
    };
  });

  const guideColor = invalid ? SPRAY_GUIDE_COLORS.invalid : SPRAY_GUIDE_COLORS.valid;

  // Written out rather than looked up by index: the i18n linter only accepts
  // literal keys, and four corners is four lines.
  const cornerLabels = [
    t('sprayWizard.anchors.cornerTopLeft'),
    t('sprayWizard.anchors.cornerTopRight'),
    t('sprayWizard.anchors.cornerBottomRight'),
    t('sprayWizard.anchors.cornerBottomLeft'),
  ];

  const layout = cornerLayerLayout({ width: renderWidth, height: renderHeight });

  return (
    // The handle layer is half a handle bigger than the photo on every side, and
    // only the PHOTO is clipped. A ring dragged onto a true corner of the photo
    // used to lose three quarters of itself, and of its touch target, to the
    // frame's rounded clip.
    <View style={layout.layer}>
      <View style={[styles.frame, layout.frame, { borderRadius: borderRadius.lg }]}>
        <Image
          source={{ uri: photo.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          accessibilityIgnoresInvertColors
        />
      </View>
      <Svg pointerEvents="none" style={[styles.outline, layout.frame]} width={renderWidth} height={renderHeight}>
        {/* Dark halo under the light guide, so the outline reads on a bright photo too. */}
        <AnimatedPath
          animatedProps={outlineProps}
          fill="none"
          stroke={SPRAY_GUIDE_COLORS.halo}
          strokeWidth={4}
          strokeLinejoin="round"
        />
        <AnimatedPath
          animatedProps={outlineProps}
          fill={guideColor}
          fillOpacity={0.12}
          stroke={guideColor}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </Svg>
      {CORNER_ORDER.map((corner) => (
        <CornerHandle
          key={corner}
          x={xs[corner]}
          y={ys[corner]}
          maxX={renderWidth}
          maxY={renderHeight}
          renderScale={renderScale}
          offset={layout.handleOffset}
          onDragActiveChange={reportDragActive}
          color={guideColor}
          label={cornerLabels[corner]}
          onCommit={commit}
        />
      ))}
    </View>
  );
}

/**
 * The guides sit on a PHOTO, which does not change with the app's colour scheme,
 * so they must not either. The light (dark-scheme) brand tint and error red read
 * on a dark photo; a dark halo under each keeps them visible on a bright one.
 */
export const SPRAY_GUIDE_COLORS = {
  valid: brandColorsDark.tint,
  invalid: brandColorsDark.error,
  halo: 'rgba(0, 0, 0, 0.55)',
} as const;

function CornerHandle({
  x,
  y,
  maxX,
  maxY,
  renderScale,
  offset,
  onDragActiveChange,
  color,
  label,
  onCommit,
}: {
  x: SharedValue<number>;
  y: SharedValue<number>;
  maxX: number;
  maxY: number;
  /** Render points per photo pixel at the current fit. */
  renderScale: number;
  /** From `cornerLayerLayout`: added to (x, y) to place the handle in its layer. */
  offset: number;
  /** Stable for the life of the marker. */
  onDragActiveChange: (active: boolean) => void;
  color: string;
  label: string;
  /** Stable for the life of the marker. */
  onCommit: () => void;
}) {
  // Where the drag started, in PHOTO pixels. Not render points: if the frame is
  // re-fitted while this finger is still down (another ring released into a
  // refusal, an iPad turned), a start remembered at the old scale would make the
  // ring jump on the next move.
  const startPhotoX = useSharedValue(0);
  const startPhotoY = useSharedValue(0);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          startPhotoX.value = x.value / renderScale;
          startPhotoY.value = y.value / renderScale;
          runOnJS(onDragActiveChange)(true);
        })
        .onUpdate((event) => {
          // Clamped to the photo: an anchor outside the frame describes a corner
          // the photograph never saw, and the homography solved from it maps the
          // wall to somewhere nobody can check.
          x.value = Math.min(maxX, Math.max(0, startPhotoX.value * renderScale + event.translationX));
          y.value = Math.min(maxY, Math.max(0, startPhotoY.value * renderScale + event.translationY));
        })
        .onEnd(() => {
          runOnJS(onCommit)();
        })
        // Always follows `onBegin`, including for a touch that never became a drag.
        .onFinalize(() => {
          runOnJS(onDragActiveChange)(false);
        }),
    // Shared values and the marker's two ref-backed callbacks never change
    // identity; `maxX`, `maxY` and `renderScale` change only when the photo is
    // re-fitted. Nothing here moves when a parent re-renders.
    [x, y, startPhotoX, startPhotoY, maxX, maxY, renderScale, onCommit, onDragActiveChange],
  );

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value + offset }, { translateY: y.value + offset }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[styles.handle, style]}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
      >
        <View style={styles.ringHalo}>
          <View style={[styles.ring, { borderColor: color }]} />
        </View>
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
  outline: {
    position: 'absolute',
  },
  handle: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringHalo: {
    width: RING_SIZE + 4,
    height: RING_SIZE + 4,
    borderRadius: (RING_SIZE + 4) / 2,
    borderWidth: 2,
    borderColor: SPRAY_GUIDE_COLORS.halo,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
  },
});
