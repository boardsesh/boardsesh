// Where a horizontal chip rail (the tick sheets' grade rail and tries rail)
// comes to rest on its own, before the climber touches it.
//
// The rail rests once per GEOMETRY, not once per mount. On iPad the sheet's
// content is laid out at the window width before SwiftUI presents the sheet,
// then again at the sheet's width (about 580pt). A rail that rested once on the
// first, window-wide pass kept that offset and opened on V0 with the consensus
// grade off screen (#7062). Keying the rest on the focus chip and both widths
// lets the rail follow the sheet's real width, a rotation, or a new focus chip,
// while the first tap or drag still stops it for good: a rail must never scroll
// itself out from under the climber's thumb.
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { railRestOffset, railSnapOffsets, type RailChipLayout } from './grade-rail-offset';

/** The one ScrollView method the rail needs. */
export type RailScrollTarget = { scrollTo: (options: { x: number; animated: boolean }) => void };

type UseRailRestArgs = {
  scrollRef: RefObject<RailScrollTarget | null>;
  /** The chip the rail should show, or undefined to leave the rail where it is. */
  focusId: number | undefined;
  /** The content's leading padding, so a chip lands flush on the rail's edge. */
  leadIn: number;
  /** Rest on a chip start (a rail that snaps while scrolling) instead of centring. */
  snapToChipStart: boolean;
};

export function useRailRest({ scrollRef, focusId, leadIn, snapToChipStart }: UseRailRestArgs) {
  const chipLayoutsRef = useRef<Record<number, RailChipLayout>>({});
  // Refs, not state: a layout handler bound in an earlier render must still see
  // the newest widths, whatever order native delivers the rail, content and chip
  // layouts in.
  const railWidthRef = useRef(0);
  const contentWidthRef = useRef(0);
  // Bumped whenever a chip re-measures, so the snap table recomputes off the
  // layout ref without every chip's onLayout forcing a render of its own.
  const [layoutVersion, setLayoutVersion] = useState(0);
  // The focus chip and widths the rail last rested for. A new value is a new
  // rest; the same value is a no-op, so repeated layout events do not scroll.
  const restedGeometryRef = useRef<string | null>(null);
  // Latched by the first tap or drag. Cleared only by `resetLatches`.
  const userInteractedRef = useRef(false);

  const snapOffsets = useMemo(() => {
    void layoutVersion;
    return railSnapOffsets(chipLayoutsRef.current, leadIn);
  }, [layoutVersion, leadIn]);

  const maybeRest = useCallback(() => {
    if (userInteractedRef.current) return;
    const railWidth = railWidthRef.current;
    const contentWidth = contentWidthRef.current;
    const geometry = `${focusId ?? ''}|${railWidth}|${contentWidth}`;
    if (restedGeometryRef.current === geometry) return;
    const offset = railRestOffset({
      layouts: chipLayoutsRef.current,
      focusId,
      railWidth,
      contentWidth,
      leadIn,
      snapToChipStart,
    });
    if (offset == null) return;
    restedGeometryRef.current = geometry;
    scrollRef.current?.scrollTo({ x: offset, animated: false });
  }, [scrollRef, focusId, leadIn, snapToChipStart]);

  const onChipLayout = useCallback(
    (chipId: number, layout: RailChipLayout) => {
      const previous = chipLayoutsRef.current[chipId];
      chipLayoutsRef.current[chipId] = layout;
      if (previous?.x !== layout.x || previous?.width !== layout.width) {
        setLayoutVersion((version) => version + 1);
      }
      maybeRest();
    },
    [maybeRest],
  );

  const onRailLayout = useCallback(
    (event: LayoutChangeEvent) => {
      railWidthRef.current = event.nativeEvent.layout.width;
      maybeRest();
    },
    [maybeRest],
  );

  const onContentSizeChange = useCallback(
    (width: number) => {
      contentWidthRef.current = width;
      maybeRest();
    },
    [maybeRest],
  );

  /** The climber tapped or dragged the rail: it never moves itself again. */
  const markInteracted = useCallback(() => {
    userInteractedRef.current = true;
  }, []);

  /** The rail now shows something else (another climb, another grade set):
   *  forget the touch and the last rest so it rests on its new focus chip. */
  const resetLatches = useCallback(() => {
    userInteractedRef.current = false;
    restedGeometryRef.current = null;
  }, []);

  return {
    snapOffsets,
    maybeRest,
    onChipLayout,
    onRailLayout,
    onContentSizeChange,
    markInteracted,
    resetLatches,
  };
}
