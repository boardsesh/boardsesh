import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { useAnimatedStyle, useSharedValue, withSpring, runOnJS } from 'react-native-reanimated';
import { springs } from '../../theme/animations';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';

// The "Wall Finder" panel is a NON-MODAL inline sheet over a full-screen map: a
// bottom-anchored View whose top edge the user drags between three detents while
// the uncovered map above stays pannable (no scrim, no full-screen touch-catcher).
// This hook generalises play-drawer/use-drawer-dismiss-gesture from a binary
// pull-down-dismiss into a clamped, multi-detent translateY, reusing its proven
// wiring: a single Gesture.Pan built ONCE (deps are only shared values), a
// `startedAtTop` capture so a scroll-to-top doesn't yank the sheet, and a Native
// gesture so the inner FlashList scrolls simultaneously instead of starving the
// drag (the documented gorhom-era "only drags in the handle strip" bug).

export type GymPanelDetent = 'low' | 'medium' | 'high';

/** Fraction of the screen the panel covers at the High detent (the tallest). */
const HIGH_FRACTION = 0.9;
/** Fraction at the Medium (default) detent — biased tall because the list is the point. */
const MEDIUM_FRACTION = 0.55;
/** Vertical travel (px) before the drag activates (lets taps focus the search field). */
const ACTIVATE_OFFSET_Y = 12;
/** Horizontal travel (px) that bails the drag (so it never steals a future row swipe). */
const FAIL_OFFSET_X = 24;
/** Velocity projection (s) folded into the release position when picking the snap target. */
const VELOCITY_PROJECTION = 0.12;
/** Slack (px) for "is the panel at its High detent" comparisons. */
const HIGH_EPSILON = 2;
/** Fallback header height (px) before the real one is measured — avoids a first-frame jump. */
const DEFAULT_HEADER_HEIGHT = 104;

function clampWorklet(value: number, min: number, max: number): number {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

type UseGymPanelGestureOptions = {
  /** When the native map can't render, the Low ("reveal the map") detent is dropped
   *  from the snap set and the panel opens High — a peek over a dead map is worse. */
  mapAvailable: boolean;
  /**
   * The height of the box the panel is laid out in. Defaults to the window: the
   * panel over a full-screen map (/gyms). While the keyboard is up the screen
   * passes the height above it, and the panel re-snaps to its detent whenever
   * that height changes.
   */
  availableHeight?: number;
};

type UseGymPanelGestureReturn = {
  /** The panel drag — attach to a GestureDetector wrapping the whole panel. */
  gesture: GestureType;
  /** Wrap the FlashList in a GestureDetector with this so its scroll runs simultaneously. */
  nativeGesture: GestureType;
  /** Apply to the panel's animated wrapper (drives translateY on the UI thread). */
  panelAnimatedStyle: ReturnType<typeof useAnimatedStyle>;
  /** Fixed panel height (the tallest visible height) — the View is translated down from here. */
  panelHeight: number;
  /** The list scrolls only at the High detent; below it the whole panel drags instead.
   *  (Toggled on settled-detent change, never per-frame — safe for the gesture.) */
  scrollEnabled: boolean;
  /** The current settled detent (for the screen's map↔list cross-reference decisions). */
  settledDetent: GymPanelDetent;
  /** Feed the FlashList's onScroll here so the drag knows when the list is at its top. */
  onListScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** Measure the pinned header so the Low detent peeks exactly the header height. */
  onHeaderLayout: (event: LayoutChangeEvent) => void;
  /** Imperatively spring to a detent (e.g. nudge Low→Medium when a pin is tapped). */
  snapTo: (detent: GymPanelDetent) => void;
  /** Nudge Low→Medium so a tapped row is on screen; never yanks down from Medium/High. */
  ensureVisible: () => void;
};

export function useGymPanelGesture({
  mapAvailable,
  availableHeight,
}: UseGymPanelGestureOptions): UseGymPanelGestureReturn {
  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(DEFAULT_HEADER_HEIGHT);
  const boxHeight = availableHeight ?? screenHeight;
  const hasLow = mapAvailable;

  // Detent positions as the panel's top-edge Y (px from the box's top). Lower Y =
  // taller panel. The panel View is `panelHeight` tall and translated DOWN from the
  // High position, so translateY == one of these top-Y values.
  const highTopY = boxHeight * (1 - HIGH_FRACTION);
  const mediumTopY = boxHeight * (1 - MEDIUM_FRACTION);
  const lowVisible = headerHeight + insets.bottom + spacing[2];
  const lowTopY = boxHeight - lowVisible;
  const panelHeight = boxHeight - highTopY;

  const defaultDetent: GymPanelDetent = mapAvailable ? 'medium' : 'high';
  const defaultTopY = mapAvailable ? mediumTopY : highTopY;

  const [settledDetent, setSettledDetent] = useState<GymPanelDetent>(defaultDetent);
  const [scrollEnabled, setScrollEnabled] = useState(defaultDetent === 'high');
  const settledDetentRef = useRef(settledDetent);
  settledDetentRef.current = settledDetent;

  // --- shared values the worklet reads (so the Pan is built once, never rebuilt) ---
  const translateY = useSharedValue(defaultTopY);
  const highTopYSV = useSharedValue(highTopY);
  const mediumTopYSV = useSharedValue(mediumTopY);
  const lowTopYSV = useSharedValue(lowTopY);
  const hasLowSV = useSharedValue(hasLow);
  const headerHeightSV = useSharedValue<number>(headerHeight);
  const listAtTopSV = useSharedValue(true);
  // Captured at gesture start.
  const startTranslateY = useSharedValue(defaultTopY);
  const startedInHeader = useSharedValue(false);
  const startedAtTop = useSharedValue(true);
  const atHighAtStart = useSharedValue(defaultDetent === 'high');

  // Keep the worklet's geometry fresh as the screen rotates / the header measures /
  // the map's availability resolves — without tearing down the gesture.
  useEffect(() => {
    highTopYSV.value = highTopY;
    mediumTopYSV.value = mediumTopY;
    lowTopYSV.value = lowTopY;
    hasLowSV.value = hasLow;
    headerHeightSV.value = headerHeight;
  }, [
    highTopY,
    mediumTopY,
    lowTopY,
    hasLow,
    headerHeight,
    highTopYSV,
    mediumTopYSV,
    lowTopYSV,
    hasLowSV,
    headerHeightSV,
  ]);

  const onListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      listAtTopSV.value = event.nativeEvent.contentOffset.y <= 0;
    },
    [listAtTopSV],
  );

  const onHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    if (measured > 0) setHeaderHeight((prev) => (Math.abs(prev - measured) > 1 ? measured : prev));
  }, []);

  // JS-side settle: mirror the worklet's snap into React state (scrollEnabled +
  // settledDetent) and fire the selection haptic. Gated to detent CHANGES only.
  const handleSettle = useCallback((detent: GymPanelDetent) => {
    setSettledDetent((prev) => {
      if (prev === detent) return prev;
      hapticSelection();
      return detent;
    });
    setScrollEnabled(detent === 'high');
  }, []);
  const handleSettleRef = useRef(handleSettle);
  handleSettleRef.current = handleSettle;
  const onSettle = useCallback((detent: GymPanelDetent) => handleSettleRef.current(detent), []);

  const snapTo = useCallback(
    (detent: GymPanelDetent) => {
      const target = detent === 'high' ? highTopY : detent === 'medium' ? mediumTopY : lowTopY;
      translateY.value = withSpring(target, { ...springs.gentle, overshootClamping: true });
      atHighAtStart.value = detent === 'high';
      handleSettleRef.current(detent);
    },
    [highTopY, mediumTopY, lowTopY, translateY, atHighAtStart],
  );

  // A measured box that changes height (a keyboard, place suggestions opening
  // above it) moves every detent: keep the panel on the one it settled on. The
  // full-screen panel keeps the window's height and never needs this.
  const measuredBox = availableHeight !== undefined;
  useEffect(() => {
    if (!measuredBox) return;
    const detent = settledDetentRef.current;
    translateY.value = detent === 'high' ? highTopY : detent === 'medium' ? mediumTopY : lowTopY;
  }, [measuredBox, highTopY, mediumTopY, lowTopY, translateY]);

  const ensureVisible = useCallback(() => {
    if (settledDetentRef.current === 'low') snapTo('medium');
  }, [snapTo]);

  const gesture = useMemo(() => {
    return Gesture.Pan()
      .maxPointers(1)
      .activeOffsetY([-ACTIVATE_OFFSET_Y, ACTIVATE_OFFSET_Y])
      .failOffsetX([-FAIL_OFFSET_X, FAIL_OFFSET_X])
      .onBegin((event) => {
        'worklet';
        startTranslateY.value = translateY.value;
        startedInHeader.value = event.y <= headerHeightSV.value;
        startedAtTop.value = listAtTopSV.value;
        atHighAtStart.value = translateY.value <= highTopYSV.value + HIGH_EPSILON;
      })
      .onUpdate((event) => {
        'worklet';
        // The panel owns the drag when: the touch began on the header (the grab
        // zone always moves the sheet), OR the sheet isn't fully expanded yet, OR
        // the list is at its top and the finger is heading down (collapse). Else
        // the finger feeds the native list scroll (running simultaneously) and the
        // sheet holds its High position.
        const panelOwns =
          startedInHeader.value || !atHighAtStart.value || (startedAtTop.value && event.translationY > 0);
        if (panelOwns) {
          translateY.value = clampWorklet(
            startTranslateY.value + event.translationY,
            highTopYSV.value,
            lowTopYSV.value,
          );
        } else {
          translateY.value = startTranslateY.value;
        }
      })
      .onEnd((event) => {
        'worklet';
        const projected = translateY.value + VELOCITY_PROJECTION * event.velocityY;
        // Candidate detents (Low is dropped when there's no map to reveal).
        const high = highTopYSV.value;
        const medium = mediumTopYSV.value;
        const low = lowTopYSV.value;
        let target = high;
        let detent: GymPanelDetent = 'high';
        if (Math.abs(projected - medium) < Math.abs(projected - target)) {
          target = medium;
          detent = 'medium';
        }
        if (hasLowSV.value && Math.abs(projected - low) < Math.abs(projected - target)) {
          target = low;
          detent = 'low';
        }
        translateY.value = withSpring(target, { ...springs.gentle, overshootClamping: true });
        runOnJS(onSettle)(detent);
      });
  }, [
    translateY,
    startTranslateY,
    startedInHeader,
    startedAtTop,
    atHighAtStart,
    headerHeightSV,
    listAtTopSV,
    highTopYSV,
    mediumTopYSV,
    lowTopYSV,
    hasLowSV,
    onSettle,
  ]);

  // The inner scrollable declares itself a Native gesture so the ancestor Pan can
  // run simultaneously with it (otherwise the native scroll wins and the panel
  // only drags in the bare handle strip).
  const nativeGesture = useMemo(() => Gesture.Native(), []);
  const composedGesture = useMemo(
    () => gesture.simultaneousWithExternalGesture(nativeGesture),
    [gesture, nativeGesture],
  );

  const panelAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return {
    gesture: composedGesture,
    nativeGesture,
    panelAnimatedStyle,
    panelHeight,
    scrollEnabled,
    settledDetent,
    onListScroll,
    onHeaderLayout,
    snapTo,
    ensureVisible,
  };
}
