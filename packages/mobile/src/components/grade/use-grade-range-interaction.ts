import { useCallback, useEffect, useRef } from 'react';
import {
  RANGE_EXTEND_WINDOW_MS,
  clearGradeBound,
  computeGradeTap,
  extendGradeRange,
  findSelectedGradeStop,
  isAnyGrade,
  isSameGradeBound,
  type GradeBound,
  type GradeStop,
} from '@boardsesh/climb-filters';
import { hapticSelection } from '../../lib/haptics';
import type { RangeRailChange } from './RangeRail';

/** Shared interaction rules for React Native and Compose grade rails. */
export function useGradeRangeInteraction<Stop extends GradeStop>({
  bound,
  stops,
  onChange,
  markInteracted,
}: {
  bound: GradeBound;
  stops: readonly Stop[];
  onChange: (next: GradeBound, change: RangeRailChange) => void;
  markInteracted: () => void;
}) {
  const lastSinglePickAtRef = useRef<number | undefined>(undefined);
  const reportedBoundRef = useRef<GradeBound | null>(null);
  const seenBoundRef = useRef(bound);
  useEffect(() => {
    if (isSameGradeBound(seenBoundRef.current, bound)) return;
    seenBoundRef.current = bound;
    const reported = reportedBoundRef.current;
    reportedBoundRef.current = null;
    if (!reported || !isSameGradeBound(reported, bound)) lastSinglePickAtRef.current = undefined;
  }, [bound]);
  // Report a change the climber made. A hold on a stop that already ends the
  // range changes nothing, so it reports nothing.
  const commit = useCallback(
    (next: GradeBound, change: RangeRailChange) => {
      if (isSameGradeBound(next, bound)) return;
      reportedBoundRef.current = next;
      onChange(next, change);
    },
    [bound, onChange],
  );

  const anySelected = isAnyGrade(bound);
  const selectedStop = findSelectedGradeStop(bound, stops);

  const handleTapStop = useCallback(
    (stop: Stop) => {
      hapticSelection();
      markInteracted();
      const tappedAt = Date.now();
      const lastSinglePickAt = lastSinglePickAtRef.current;
      const withinExtendWindow = lastSinglePickAt !== undefined && tappedAt - lastSinglePickAt < RANGE_EXTEND_WINDOW_MS;
      const next = computeGradeTap(bound, stop, stops, withinExtendWindow);
      // Any tap that leaves one stop selected is a fresh pick and opens the
      // window; a tap that made a range or cleared closes it.
      lastSinglePickAtRef.current = findSelectedGradeStop(next, stops) ? tappedAt : undefined;
      // The window only decides a tap on a different stop than the one selected.
      const decidedByWindow = selectedStop !== undefined && stop !== selectedStop;
      commit(next, { gesture: 'tap', ...(decidedByWindow && { withinRangeWindow: withinExtendWindow }) });
    },
    [bound, stops, selectedStop, commit, markInteracted],
  );

  // Touch and hold makes or moves a range without the clock. It also closes the
  // window, so the tap after a hold is a plain pick.
  const handleHoldStop = useCallback(
    (stop: Stop) => {
      hapticSelection();
      markInteracted();
      lastSinglePickAtRef.current = undefined;
      commit(extendGradeRange(bound, stop, stops), { gesture: 'hold' });
    },
    [bound, stops, commit, markInteracted],
  );

  const handleClear = useCallback(() => {
    hapticSelection();
    markInteracted();
    lastSinglePickAtRef.current = undefined;
    commit(clearGradeBound(), { gesture: 'clear' });
  }, [commit, markInteracted]);

  return { anySelected, selectedStop, handleTapStop, handleHoldStop, handleClear };
}
