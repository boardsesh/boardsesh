// Scroll a focused field in a sheet's scroll body into view, above the pinned
// footer (#5665).
//
// The native sheet does nothing here. `@expo/ui`'s `BottomSheetTextInput` and
// `BottomSheetScrollView` are plain RN `TextInput` / `ScrollView` re-exports
// (`@expo/ui` 57 `src/community/bottom-sheet/index.tsx`). The sheet's
// `KeyboardAvoidingView` pads the column by the keyboard height, so the scroll
// body gets shorter from the bottom while its offset stays where it was. With
// the keyboard up an iOS tick sheet shows about 162pt of body (derivation in
// `tick/TickNoteField.tsx`). The edit sheet's note starts 352pt down, so the
// climber typed blind. RN's own `automaticallyAdjustKeyboardInsets` does not
// fit: it is iOS-only, adds an inset on top of the KAV padding, and scrolls to
// the keyboard's top edge, not the footer's.
//
// So the sheet owns the scroll. A field opts in by calling `reveal(ref)` from
// `useSheetScrollIntoView()` when it gains focus. The sheet measures the field
// against the scroll body's content view and scrolls until the field's bottom
// clears the viewport's bottom edge. It does that again every time the viewport
// changes height, because the keyboard padding and the taller keyboard detent
// both arrive as layout changes after the focus event.
import { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import {
  Platform,
  type HostInstance,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from 'react-native';
import { spacing } from '../theme/tokens';

/** Clearance between a revealed field's bottom edge and the viewport's bottom edge. */
export const SHEET_REVEAL_MARGIN = spacing[3]; // 12

type RevealGeometry = {
  /** Field top, in scroll-content coordinates. */
  targetY: number;
  targetHeight: number;
  /** Visible height of the scroll body right now. */
  viewportHeight: number;
  /** Scroll content height; 0 when not measured yet (no clamp then). */
  contentHeight: number;
  currentOffset: number;
  margin: number;
};

/**
 * The scroll offset that brings a field fully into view, or `null` when it is
 * already in view (or no viewport has been measured yet).
 *
 * Moves as little as possible: a field below the fold lands with its bottom
 * `margin` above the viewport's bottom, and a field above the fold lands at the
 * top. A field taller than the viewport shows its top, where the caret starts.
 */
export function revealScrollOffset({
  targetY,
  targetHeight,
  viewportHeight,
  contentHeight,
  currentOffset,
  margin,
}: RevealGeometry): number | null {
  if (viewportHeight <= 0) return null;
  const targetBottom = targetY + targetHeight + margin;
  let next: number;
  if (targetHeight + margin > viewportHeight) {
    next = targetY;
  } else if (targetBottom > currentOffset + viewportHeight) {
    next = targetBottom - viewportHeight;
  } else if (targetY < currentOffset) {
    next = targetY;
  } else {
    return null;
  }
  const maxOffset = contentHeight > 0 ? Math.max(0, contentHeight - viewportHeight) : Number.POSITIVE_INFINITY;
  const clamped = Math.min(Math.max(0, next), maxOffset);
  return Math.abs(clamped - currentOffset) < 1 ? null : clamped;
}

/** Anything with the native `measureLayout` (a `TextInput` ref, a host `View`). */
export type SheetRevealTarget = Pick<HostInstance, 'measureLayout'>;

export type SheetScrollIntoView = {
  /** Keep this field in view: scroll now, and again on every viewport resize. */
  reveal: (target: SheetRevealTarget) => void;
  /** Stop tracking the field (call on blur). A no-op for any other field. */
  release: (target: SheetRevealTarget) => void;
};

const SheetScrollIntoViewContext = createContext<SheetScrollIntoView | null>(null);

export const SheetScrollIntoViewProvider = SheetScrollIntoViewContext.Provider;

/** `null` outside a scrollable `Sheet` / `ModalSheet`, and on web. */
export function useSheetScrollIntoView(): SheetScrollIntoView | null {
  return useContext(SheetScrollIntoViewContext);
}

// `ScrollView.getInnerViewRef()` returns the content container's host instance
// (RN 0.86 `Libraries/Components/ScrollView/ScrollView.js:870-872`, the ref set
// at :1738). The public `.d.ts` leaves it out, hence the narrow structural read.
// Measuring against the content view gives content coordinates, independent of
// the current scroll offset. `measureLayout` needs a host instance, not a node
// handle (`src/private/webapis/dom/nodes/ReactNativeElement.js:177-203`).
function contentViewOf(scrollView: ScrollView): HostInstance | null {
  const { getInnerViewRef } = scrollView as unknown as { getInnerViewRef?: () => HostInstance | null };
  return typeof getInnerViewRef === 'function' ? getInnerViewRef.call(scrollView) : null;
}

type SheetScrollIntoViewHostOptions = {
  /** The sheet's own body `onLayout` (the #3922 probe). Still runs. */
  onBodyLayout?: (event: LayoutChangeEvent) => void;
  /** Index of the tallest detent the sheet can move to; 0 for a single-detent or
   *  content-fitted sheet, which has nowhere to grow. */
  lastDetentIndex: number;
  /** The detent the sheet rests at now. */
  activeIndex: number;
  snapToIndex: (index: number) => void;
};

/**
 * Host side, for `Sheet` / `ModalSheet`: returns the context value to provide
 * and the props to spread on the scroll body.
 *
 * A reveal also raises the sheet to its tallest detent (the keyboard detent).
 * The iOS column is pinned to the detent it rests at (`useSheetColumnStyle`),
 * and nothing else moves it when a field gets focus. At the tick sheets' first
 * detent the keyboard leaves less room than the header and footer need, so no
 * scroll could bring the field into view there. The detent change lands as a
 * body layout change, which runs the reveal again.
 *
 * Off on web: the Expo-web shim's Gorhom sheet has its own keyboard handling.
 */
export function useSheetScrollIntoViewHost({
  onBodyLayout,
  lastDetentIndex,
  activeIndex,
  snapToIndex,
}: SheetScrollIntoViewHostOptions) {
  const scrollRef = useRef<ScrollView>(null);
  const viewportHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const offsetRef = useRef(0);
  const activeTargetRef = useRef<SheetRevealTarget | null>(null);

  const revealActive = useCallback(() => {
    const target = activeTargetRef.current;
    const scrollView = scrollRef.current;
    if (!target || !scrollView) return;
    const contentView = contentViewOf(scrollView);
    if (!contentView) return;
    target.measureLayout(contentView, (_left, top, _width, height) => {
      // The field may have blurred while the measurement was in flight.
      if (activeTargetRef.current !== target) return;
      const next = revealScrollOffset({
        targetY: top,
        targetHeight: height,
        viewportHeight: viewportHeightRef.current,
        contentHeight: contentHeightRef.current,
        currentOffset: offsetRef.current,
        margin: SHEET_REVEAL_MARGIN,
      });
      if (next == null) return;
      offsetRef.current = next;
      scrollView.scrollTo({ y: next, animated: true });
    });
  }, []);

  const expandToLastDetent = useCallback(() => {
    if (lastDetentIndex > 0 && activeIndex < lastDetentIndex) snapToIndex(lastDetentIndex);
  }, [activeIndex, lastDetentIndex, snapToIndex]);

  const scrollIntoView = useMemo<SheetScrollIntoView | null>(
    () =>
      Platform.OS === 'web'
        ? null
        : {
            reveal: (target) => {
              activeTargetRef.current = target;
              expandToLastDetent();
              revealActive();
            },
            release: (target) => {
              if (activeTargetRef.current === target) activeTargetRef.current = null;
            },
          },
    [expandToLastDetent, revealActive],
  );

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onBodyLayout?.(event);
      const { height } = event.nativeEvent.layout;
      if (height === viewportHeightRef.current) return;
      viewportHeightRef.current = height;
      revealActive();
    },
    [onBodyLayout, revealActive],
  );

  const onContentSizeChange = useCallback((_width: number, height: number) => {
    contentHeightRef.current = height;
  }, []);

  // A ref write, never state: no re-render per scroll event.
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  const scrollProps = useMemo(
    () => ({ ref: scrollRef, onLayout, onContentSizeChange, onScroll, scrollEventThrottle: 32 }),
    [onLayout, onContentSizeChange, onScroll],
  );

  return { scrollIntoView, scrollProps };
}
