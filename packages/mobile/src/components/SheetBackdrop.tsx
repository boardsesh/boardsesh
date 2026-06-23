import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, type ViewProps } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
} from 'react-native-reanimated';
import { useBottomSheet, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';

export type SheetBackdropProps = BottomSheetBackdropProps & {
  /** Snap index at/above which the scrim is fully shown (default 0). */
  appearsOnIndex?: number;
  /** Snap index at/below which the scrim is hidden and non-interactive (default -1). */
  disappearsOnIndex?: number;
  /** Peak scrim opacity at `appearsOnIndex` (default 0.5). */
  opacity?: number;
  /** What a backdrop tap does. `'none'` makes the scrim inert. */
  pressBehavior?: 'none' | 'close' | 'collapse' | number;
  onPress?: () => void;
  children?: ReactNode;
  accessible?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

/**
 * Drop-in replacement for gorhom's `BottomSheetBackdrop` with a touchability gate
 * that survives fractional display densities.
 *
 * gorhom derives the sheet's `animatedIndex` by interpolating `animatedPosition`
 * against the snap-point positions, which are resolved in (pixel-rounded) device
 * pixels. On a non-default Android "Display size" the pixel ratio is fractional
 * (e.g. a Pixel 8 at the 2nd display-size step reports density 306 → ratio
 * 1.9125), so the fully-closed position no longer lands exactly on the close
 * detent: `animatedIndex` settles a hair above its -1 target (≈ -0.9997).
 *
 * gorhom's stock backdrop gates `pointerEvents` on the exact comparison
 * `animatedIndex <= disappearsOnIndex`. That sub-pixel drift makes the comparison
 * read `false` for a *closed* sheet, so the backdrop is never flipped back to
 * `pointerEvents:'none'`. The scrim's interpolated opacity is ~0 (invisible), but
 * it still captures every touch — the whole app goes dead to scroll and taps
 * until a relayout (rotate / split-screen / display-size change) nudges the index
 * back onto -1. We gate on a small tolerance past `disappearsOnIndex` instead, so
 * an effectively-invisible scrim is always non-interactive.
 *
 * Touchability rides JS state driven by a worklet reaction (gorhom's proven
 * mechanism — animating `pointerEvents` through `useAnimatedProps` is unreliable
 * on Android Fabric), with `isMounted` seeded `true` so the very first reaction
 * tick lands even if it fires before the mount effect (gorhom #2680).
 */

/**
 * Tolerance, in snap-index units, applied past `disappearsOnIndex` when deciding
 * whether the scrim should receive touches. Comfortably larger than the sub-pixel
 * index drift seen on fractional densities (order 1e-4) yet far below the gap to
 * the next snap point (>= 1), so it never makes a genuinely-open sheet inert.
 */
export const CLOSE_INDEX_EPSILON = 0.05;

/**
 * Whether a backdrop at `animatedIndex` should receive touches. The scrim is
 * interactive only once the sheet is open past the close detent by more than the
 * drift tolerance — so a closed sheet whose index settles a hair above
 * `disappearsOnIndex` (the fractional-density bug) is correctly treated as inert.
 * Mirrors the opacity interpolation, which is already ~0 in that range.
 */
export function isBackdropInteractive(animatedIndex: number, disappearsOnIndex: number): boolean {
  'worklet';
  return animatedIndex > disappearsOnIndex + CLOSE_INDEX_EPSILON;
}

function SheetBackdropComponent({
  animatedIndex,
  style,
  appearsOnIndex = 0,
  disappearsOnIndex = -1,
  opacity: maxOpacity = 0.5,
  pressBehavior = 'close',
  onPress,
  children,
  // Match gorhom's BottomSheetBackdrop a11y defaults so screen readers still get a
  // "tap to close" element — the only intended behaviour change here is touchability.
  accessible = true,
  accessibilityLabel = 'Bottom sheet backdrop',
  accessibilityHint = 'Tap to close the bottom sheet',
}: SheetBackdropProps) {
  const { snapToIndex, close } = useBottomSheet();

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const [pointerEvents, setPointerEvents] = useState<ViewProps['pointerEvents']>('none');
  const applyTouchability = useCallback((interactive: boolean) => {
    if (isMounted.current) setPointerEvents(interactive ? 'auto' : 'none');
  }, []);

  useAnimatedReaction(
    () => isBackdropInteractive(animatedIndex.value, disappearsOnIndex),
    (interactive, previous) => {
      if (interactive !== previous) runOnJS(applyTouchability)(interactive);
    },
    [disappearsOnIndex],
  );

  const containerStyle = useAnimatedStyle(
    () => ({
      opacity: interpolate(
        animatedIndex.value,
        [-1, disappearsOnIndex, appearsOnIndex],
        [0, 0, maxOpacity],
        Extrapolation.CLAMP,
      ),
    }),
    [appearsOnIndex, disappearsOnIndex, maxOpacity],
  );

  const handlePress = useCallback(() => {
    onPress?.();
    if (pressBehavior === 'close') close();
    else if (pressBehavior === 'collapse') snapToIndex(disappearsOnIndex);
    else if (typeof pressBehavior === 'number') snapToIndex(pressBehavior);
  }, [onPress, pressBehavior, close, snapToIndex, disappearsOnIndex]);

  const tapGesture = useMemo(() => Gesture.Tap().onEnd(() => runOnJS(handlePress)()), [handlePress]);

  const view = (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.backdrop, style, containerStyle]}
      pointerEvents={pointerEvents}
      accessible={accessible}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
    >
      {children}
    </Animated.View>
  );

  return pressBehavior !== 'none' ? <GestureDetector gesture={tapGesture}>{view}</GestureDetector> : view;
}

// Matches gorhom's backdrop scrim colour; the animated opacity does the fade.
const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: 'black',
  },
});

export const SheetBackdrop = memo(SheetBackdropComponent);
SheetBackdrop.displayName = 'SheetBackdrop';
