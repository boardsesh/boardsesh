import React, { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { overlays, spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { hapticLight, hapticMedium, hapticSelection } from '../../lib/haptics';
import {
  RESIZE_HANDLE_HIT_PT,
  boardToScreen,
  fingertipScreenPt,
  projectOnto,
  resizeHandleAnchor,
  resizeHandleDistance,
  type ScreenRect,
} from './spray-gesture-math';
import { resizeFromDrag, type HoldRadiusBounds } from './spray-hold-tools';

/** The visible dot, at the centre of the 44 pt touch box. */
const DOT_SIZE = 12;
const DOT_EDGE = 2;
/** The "+15%" pill: its box (the label is centred in it), and how far above the handle it floats. */
const PILL_WIDTH = 96;
const PILL_HEIGHT = 28;
const PILL_GAP = 8;
/** At most one step tick per this many ms, so a fast drag hums rather than rattles. */
const STEP_TICK_MIN_MS = 30;
/** Where a hidden handle is parked: far off the board, so it cannot be hit either. */
const OFFSCREEN = -10000;
/** Anything below this line is "under the bars" for a handle the whole width of the board. */
const AVOID_RECT_SPAN = 100000;

/** Haptic weights a step can ask for, as numbers so a worklet can pass one to JS. */
const TICK_NONE = 0;
const TICK_STEP = 1;
const TICK_MAGNET = 2;
const TICK_BOUND = 3;

/** The snap point under the drag, as a number for the same reason. */
const MAGNET_NONE = 0;
const MAGNET_ORIGINAL = 1;
const MAGNET_MEDIAN = 2;

type PillLabel = { magnet: number; percent: number };

type SprayResizeHandleProps = {
  /** The board's live zoom transform, from `FilterBoardTransformContext`. */
  scaleSV: SharedValue<number>;
  translateXSV: SharedValue<number>;
  translateYSV: SharedValue<number>;
  containerWidthSV: SharedValue<number>;
  containerHeightSV: SharedValue<number>;
  isPinchingSV: SharedValue<boolean>;
  /** Declared as a relation, never composed — see `FilterBoardTransformContext.pinchGesture`. */
  pinchRef: MutableRefObject<GestureType | undefined>;
  /** Board px per render px. */
  boardScale: number;
  /**
   * The hold this handle resizes, or null for none. Its id must match
   * `selectedHoldSV`'s, so a pick-up that has already moved the UI-thread
   * selection to another ring hides the handle until React catches up.
   */
  holdId: number | null;
  /**
   * The hold's farthest reach from its centre as a multiple of its radius
   * (`holdReach / r`). A ratio, so it holds through a resize and the dot can be
   * placed from the UI thread's radius without waiting for a render.
   */
  reachRatio: number;
  /** `[id, cx, cy, r]` — shared with `SelectedHoldOverlay` and the gesture overlay. */
  selectedHoldSV: SharedValue<number[]>;
  dragOffsetXSV: SharedValue<number>;
  dragOffsetYSV: SharedValue<number>;
  /** A move is under way; the handle steps aside until it lands. */
  dragHoldIdSV: SharedValue<number>;
  /** Written here: the live scale and the hold it applies to (0 when none). Read by `SelectedHoldOverlay`. */
  resizeScaleSV: SharedValue<number>;
  resizeHoldIdSV: SharedValue<number>;
  /** The wall's median radius, the grid's unit. */
  medianRadius: number;
  bounds: HoldRadiusBounds;
  /**
   * The top of the screen's bottom dock and bar, in the board's own points: a
   * handle whose touch box would reach below it flips to another diagonal.
   */
  avoidTopSV: SharedValue<number>;
  /** The finger lifted at a new size. The screen commits it (one `RESIZE_HOLD`) or refuses it. */
  onResizeEnd: (holdId: number, radius: number) => void;
};

/**
 * The selected hold's resize handle: a 12 pt dot outside the ring, on the
 * bottom-right diagonal unless that would leave the board or sit under the
 * bars. Its 44 pt touch box never covers the ring's own disc (the ring, or a
 * fingertip around a small one), so a tap on the selected ring still toggles
 * it and a press there still picks it up — see `resizeHandleDistance`.
 *
 * One finger drags it, and the hold scales uniformly about its centre. Travel
 * is measured along the handle's own outward diagonal in SCREEN points and
 * mapped through `resizeFromDrag` (`exp(pt / 120)`, snapped to the 5% grid,
 * with magnets at the grab size and the wall's median), so a step is about 6 pt
 * at any zoom and on any size of hold. Each new step ticks; a magnet ticks
 * heavier; reaching a bound bumps once. A pill above the handle says how far
 * the size has come ("+15%"), or "Typical" on the median.
 *
 * Its own detector, activated at touch-down — which is what beats the zoomed
 * board's one-finger pan, an ancestor, to the touch — and failed by a second
 * finger, which belongs to the pinch. Rendered after the edit surface (and
 * after Draw in add mode) so it sits on top of both. Everything moves on the
 * UI thread: the ring follows `resizeScaleSV` in `SelectedHoldOverlay`, and JS
 * hears from the gesture only when the step changes (for the haptic and the
 * pill) and once on release.
 */
export const SprayResizeHandle = React.memo(function SprayResizeHandle({
  scaleSV,
  translateXSV,
  translateYSV,
  containerWidthSV,
  containerHeightSV,
  isPinchingSV,
  pinchRef,
  boardScale,
  holdId,
  reachRatio,
  selectedHoldSV,
  dragOffsetXSV,
  dragOffsetYSV,
  dragHoldIdSV,
  resizeScaleSV,
  resizeHoldIdSV,
  medianRadius,
  bounds,
  avoidTopSV,
  onResizeEnd,
}: SprayResizeHandleProps) {
  const { t } = useTranslation('boards');
  const { brandColors } = useTheme();

  // Mirrored rather than captured, so the gesture is built once — rebuilding a
  // live RNGH gesture mid-session has wedged iOS before (see use-zoom-pan-gesture).
  const boardScaleSV = useSharedValue(boardScale);
  const targetIdSV = useSharedValue(holdId ?? 0);
  const reachRatioSV = useSharedValue(reachRatio);
  const medianSV = useSharedValue(medianRadius);
  const minRadiusSV = useSharedValue(bounds.min);
  const maxRadiusSV = useSharedValue(bounds.max);
  useEffect(() => {
    boardScaleSV.value = boardScale;
    targetIdSV.value = holdId ?? 0;
    reachRatioSV.value = reachRatio;
    medianSV.value = medianRadius;
    minRadiusSV.value = bounds.min;
    maxRadiusSV.value = bounds.max;
  }, [
    boardScale,
    holdId,
    reachRatio,
    medianRadius,
    bounds,
    boardScaleSV,
    targetIdSV,
    reachRatioSV,
    medianSV,
    minRadiusSV,
    maxRadiusSV,
  ]);

  /** A resize owns the touch. */
  const activeSV = useSharedValue(false);
  /** A second finger or a pinch took over: the resize is thrown away on lift. */
  const abandonedSV = useSharedValue(false);
  const grabbedIdSV = useSharedValue(0);
  const startRadiusSV = useSharedValue(0);
  const startXSV = useSharedValue(0);
  const startYSV = useSharedValue(0);
  /** The outward diagonal at grab time. Locked for the drag, so the handle never flips under the finger. */
  const directionXSV = useSharedValue(0);
  const directionYSV = useSharedValue(0);
  const lastRadiusSV = useSharedValue(0);
  const lastMagnetSV = useSharedValue(MAGNET_ORIGINAL);
  const lastAtBoundSV = useSharedValue(false);
  const lastTickMsSV = useSharedValue(0);
  /** The size has moved off the grab size at least once this drag: the pill is worth showing. */
  const pillShownSV = useSharedValue(false);

  const [pillLabel, setPillLabel] = useState<PillLabel>({ magnet: MAGNET_ORIGINAL, percent: 0 });

  const callbacksRef = useRef({ onResizeEnd });
  callbacksRef.current = { onResizeEnd };
  // Captured once by the gesture memo — only close over the stable ref and setters.
  const handleResizeEnd = (id: number, radius: number) => callbacksRef.current.onResizeEnd(id, radius);
  const handleStep = (percent: number, magnet: number, tick: number) => {
    setPillLabel((previous) =>
      previous.percent === percent && previous.magnet === magnet ? previous : { percent, magnet },
    );
    if (tick === TICK_BOUND) hapticMedium();
    else if (tick === TICK_MAGNET) hapticLight();
    else if (tick === TICK_STEP) hapticSelection();
  };

  const gesture = useMemo(() => {
    /** Where the dot is right now, in overlay points, or null when it is hidden. */
    const currentAnchor = () => {
      'worklet';
      const selected = selectedHoldSV.value;
      const target = targetIdSV.value;
      if (target === 0 || selected.length < 4 || selected[0] !== target || dragHoldIdSV.value !== 0) return null;
      const scale = scaleSV.value;
      const centre = boardToScreen(
        selected[1] + dragOffsetXSV.value,
        selected[2] + dragOffsetYSV.value,
        scale,
        translateXSV.value,
        translateYSV.value,
        containerWidthSV.value,
        containerHeightSV.value,
        boardScaleSV.value,
      );
      const reachPt =
        boardScaleSV.value > 0
          ? ((selected[3] * reachRatioSV.value * resizeScaleSV.value) / boardScaleSV.value) * scale
          : 0;
      const avoid: ScreenRect[] = [
        { x: -AVOID_RECT_SPAN, y: avoidTopSV.value, width: AVOID_RECT_SPAN * 2, height: AVOID_RECT_SPAN },
      ];
      return resizeHandleAnchor(
        centre,
        reachPt,
        fingertipScreenPt(scale),
        { width: containerWidthSV.value, height: containerHeightSV.value },
        avoid,
      );
    };

    const abandon = () => {
      'worklet';
      abandonedSV.value = true;
      resizeScaleSV.value = 1;
      resizeHoldIdSV.value = 0;
      pillShownSV.value = false;
    };

    const pan = Gesture.Pan()
      .manualActivation(true)
      .onTouchesDown((event, manager) => {
        'worklet';
        if (activeSV.value) {
          // A second finger mid-resize is a pinch starting: the pinch has it.
          if (event.numberOfTouches > 1) {
            abandon();
            manager.end();
          }
          return;
        }
        const touch = event.allTouches[0];
        const anchor = currentAnchor();
        // Not `isPinchingSV` here: it is cleared by the pinch's own touch-down
        // for a fresh single finger, which may run after this one.
        if (event.numberOfTouches > 1 || !touch || anchor == null) {
          manager.fail();
          return;
        }
        const selected = selectedHoldSV.value;
        grabbedIdSV.value = selected[0];
        startRadiusSV.value = selected[3];
        lastRadiusSV.value = selected[3];
        lastMagnetSV.value = MAGNET_ORIGINAL;
        lastAtBoundSV.value = false;
        lastTickMsSV.value = 0;
        startXSV.value = touch.absoluteX;
        startYSV.value = touch.absoluteY;
        directionXSV.value = anchor.ux;
        directionYSV.value = anchor.uy;
        abandonedSV.value = false;
        pillShownSV.value = false;
        resizeScaleSV.value = 1;
        resizeHoldIdSV.value = selected[0];
        activeSV.value = true;
        manager.activate();
      })
      .onTouchesMove((event) => {
        'worklet';
        if (!activeSV.value || abandonedSV.value) return;
        if (isPinchingSV.value) {
          abandon();
          return;
        }
        const touch = event.allTouches[0];
        if (!touch) return;
        const startRadius = startRadiusSV.value;
        const projected = projectOnto(
          touch.absoluteX - startXSV.value,
          touch.absoluteY - startYSV.value,
          directionXSV.value,
          directionYSV.value,
        );
        const result = resizeFromDrag(projected, startRadius, medianSV.value, {
          min: minRadiusSV.value,
          max: maxRadiusSV.value,
        });
        resizeScaleSV.value = result.r / startRadius;
        const magnet =
          result.magnet === 'median' ? MAGNET_MEDIAN : result.magnet === 'original' ? MAGNET_ORIGINAL : MAGNET_NONE;
        // Decided before the same-size bail-out: a bound that sits exactly on a
        // grid step is reached by a step that is not yet "at the bound", and the
        // next move only flips the flag — that flip still bumps.
        const reachedBound = result.atBound && !lastAtBoundSV.value;
        if (result.r === lastRadiusSV.value && !reachedBound) {
          lastAtBoundSV.value = result.atBound;
          return;
        }
        // One hop to JS per change of size (or bound), never per frame. The
        // haptic inside it is throttled; the pill is not, so it never shows a
        // stale number.
        const now = Date.now();
        let tick = TICK_NONE;
        if (reachedBound) tick = TICK_BOUND;
        else if (magnet !== MAGNET_NONE && magnet !== lastMagnetSV.value) tick = TICK_MAGNET;
        else if (now - lastTickMsSV.value >= STEP_TICK_MIN_MS) tick = TICK_STEP;
        if (tick !== TICK_NONE) lastTickMsSV.value = now;
        lastRadiusSV.value = result.r;
        lastMagnetSV.value = magnet;
        lastAtBoundSV.value = result.atBound;
        pillShownSV.value = true;
        runOnJS(handleStep)(Math.round((result.r / startRadius - 1) * 100), magnet, tick);
      })
      .onFinalize((_event, success) => {
        'worklet';
        const grabbedId = grabbedIdSV.value;
        const radius = lastRadiusSV.value;
        const changed = radius !== startRadiusSV.value;
        const commit = activeSV.value && success && !abandonedSV.value && grabbedId !== 0 && changed;
        activeSV.value = false;
        grabbedIdSV.value = 0;
        pillShownSV.value = false;
        // The resize is over either way. On a commit the scale stays where the
        // finger left it until the reducer has the new radius, and
        // `SelectedHoldOverlay` hands it back to 1 in that same commit.
        resizeHoldIdSV.value = 0;
        if (commit) {
          runOnJS(handleResizeEnd)(grabbedId, radius);
          return;
        }
        resizeScaleSV.value = 1;
      });

    pan.simultaneousWithExternalGesture(pinchRef);
    return pan;
    // handleStep/handleResizeEnd are intentionally not deps — captured once and
    // read render-scoped values through callbacksRef and a state setter.
  }, [
    scaleSV,
    translateXSV,
    translateYSV,
    containerWidthSV,
    containerHeightSV,
    isPinchingSV,
    pinchRef,
    boardScaleSV,
    targetIdSV,
    reachRatioSV,
    medianSV,
    minRadiusSV,
    maxRadiusSV,
    selectedHoldSV,
    dragOffsetXSV,
    dragOffsetYSV,
    dragHoldIdSV,
    resizeScaleSV,
    resizeHoldIdSV,
    avoidTopSV,
    activeSV,
    abandonedSV,
    grabbedIdSV,
    startRadiusSV,
    startXSV,
    startYSV,
    directionXSV,
    directionYSV,
    lastRadiusSV,
    lastMagnetSV,
    lastAtBoundSV,
    lastTickMsSV,
    pillShownSV,
  ]);

  const handleStyle = useAnimatedStyle(() => {
    const selected = selectedHoldSV.value;
    const target = targetIdSV.value;
    const hidden = { opacity: 0, transform: [{ translateX: OFFSCREEN }, { translateY: OFFSCREEN }] };
    if (target === 0 || selected.length < 4 || selected[0] !== target || dragHoldIdSV.value !== 0) return hidden;
    const scale = scaleSV.value;
    const centre = boardToScreen(
      selected[1] + dragOffsetXSV.value,
      selected[2] + dragOffsetYSV.value,
      scale,
      translateXSV.value,
      translateYSV.value,
      containerWidthSV.value,
      containerHeightSV.value,
      boardScaleSV.value,
    );
    const reachPt =
      boardScaleSV.value > 0
        ? ((selected[3] * reachRatioSV.value * resizeScaleSV.value) / boardScaleSV.value) * scale
        : 0;
    let x: number;
    let y: number;
    if (activeSV.value) {
      // Mid-drag the diagonal is the one the finger grabbed: the dot rides the
      // growing ring out along it rather than jumping corners.
      const distance = resizeHandleDistance(reachPt, fingertipScreenPt(scale));
      x = centre.x + directionXSV.value * distance;
      y = centre.y + directionYSV.value * distance;
    } else {
      const anchor = resizeHandleAnchor(
        centre,
        reachPt,
        fingertipScreenPt(scale),
        { width: containerWidthSV.value, height: containerHeightSV.value },
        [{ x: -AVOID_RECT_SPAN, y: avoidTopSV.value, width: AVOID_RECT_SPAN * 2, height: AVOID_RECT_SPAN }],
      );
      x = anchor.x;
      y = anchor.y;
    }
    const half = RESIZE_HANDLE_HIT_PT / 2;
    // Turned 45° about its centre, so the face towards the hold is flat and
    // stays clear of the hold's own disc (`resizeHandleDistance`). Both
    // platforms' hit tests honour the rotation.
    return {
      opacity: 1,
      transform: [{ translateX: x - half }, { translateY: y - half }, { rotate: '45deg' }],
    };
  }, []);

  const pillStyle = useAnimatedStyle(() => {
    const hidden = { opacity: 0, transform: [{ translateX: OFFSCREEN }, { translateY: OFFSCREEN }] };
    const selected = selectedHoldSV.value;
    if (!pillShownSV.value || !activeSV.value || selected.length < 4) return hidden;
    const scale = scaleSV.value;
    const centre = boardToScreen(
      selected[1],
      selected[2],
      scale,
      translateXSV.value,
      translateYSV.value,
      containerWidthSV.value,
      containerHeightSV.value,
      boardScaleSV.value,
    );
    const reachPt =
      boardScaleSV.value > 0
        ? ((selected[3] * reachRatioSV.value * resizeScaleSV.value) / boardScaleSV.value) * scale
        : 0;
    const distance = resizeHandleDistance(reachPt, fingertipScreenPt(scale));
    const handleX = centre.x + directionXSV.value * distance;
    const handleY = centre.y + directionYSV.value * distance;
    const width = containerWidthSV.value;
    // Above the touch box (so the finger never covers it), or below when there
    // is no room above; kept inside the board sideways. The turned box's
    // corners reach `HIT × √½` above and below the dot.
    const boxHalfHeight = RESIZE_HANDLE_HIT_PT * Math.SQRT1_2;
    const above = handleY - boxHalfHeight - PILL_GAP - PILL_HEIGHT;
    const top = above >= 0 ? above : handleY + boxHalfHeight + PILL_GAP;
    const left = Math.min(Math.max(handleX - PILL_WIDTH / 2, 0), Math.max(0, width - PILL_WIDTH));
    return { opacity: 1, transform: [{ translateX: left }, { translateY: top }] };
  }, []);

  const pillText =
    pillLabel.magnet === MAGNET_MEDIAN
      ? t('sprayEditor.resize.typical')
      : pillLabel.percent === 0
        ? t('sprayEditor.resize.original')
        : pillLabel.percent > 0
          ? t('sprayEditor.resize.bigger', { percent: pillLabel.percent })
          : t('sprayEditor.resize.smaller', { percent: Math.abs(pillLabel.percent) });

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Animated.View pointerEvents="none" style={[styles.pillBox, pillStyle]}>
        <View style={[styles.pill, { backgroundColor: overlays.scrim }]}>
          <Text
            variant="footnote"
            color={overlays.onScrim}
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.pillLabel}
          >
            {pillText}
          </Text>
        </View>
      </Animated.View>
      <GestureDetector gesture={gesture}>
        <Animated.View
          collapsable={false}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          style={[styles.hitBox, handleStyle]}
        >
          <View style={[styles.dot, { backgroundColor: brandColors.primaryFill, borderColor: overlays.onScrim }]} />
        </Animated.View>
      </GestureDetector>
    </View>
  );
});

const styles = StyleSheet.create({
  hitBox: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: RESIZE_HANDLE_HIT_PT,
    height: RESIZE_HANDLE_HIT_PT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    borderWidth: DOT_EDGE,
  },
  pillBox: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    height: PILL_HEIGHT,
    borderRadius: PILL_HEIGHT / 2,
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillLabel: {
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
